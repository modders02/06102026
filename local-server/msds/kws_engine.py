"""MSDS custom streaming keyword spotter.

This module intentionally does not use Whisper or another speech-to-text model.
It learns short safety words from the actual CCTV microphone:

PCM -> energy VAD -> log-Mel features -> DTW template matching -> confidence.

The template approach is speaker/environment adapted: enrollment samples recorded
through the installed camera include that room's reverberation, codec artifacts
and microphone response. It is intended for low-latency safety cues, not general
sentence transcription.
"""
from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np

SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
DEFAULT_KEYWORDS = ("help", "tulong", "sunog", "magnanakaw")
FEATURE_VERSION = "logmel-shape-dtw-v2"
MIN_TEMPLATES = 3
MAX_TEMPLATES = 10
MATCH_THRESHOLD = 0.70
MATCH_MARGIN = 0.06

FRAME_MS = 25
HOP_MS = 10
N_FFT = 512
N_MELS = 32
FREQ_MIN = 80.0
FREQ_MAX = 7600.0

# Streaming VAD. The CCTV path already normalizes format to 16 kHz mono s16.
START_RMS = 0.025
CONTINUE_RMS = 0.015
MIN_SPEECH_SECONDS = 0.30
END_SILENCE_SECONDS = 0.24
MAX_SPEECH_SECONDS = 2.50
PRE_ROLL_SECONDS = 0.12

_KEYWORD_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")


@dataclass(frozen=True)
class KeywordMatch:
    keyword: str
    confidence: float
    distance: float
    runner_up_confidence: float
    duration_ms: int


@dataclass(frozen=True)
class KeywordDecision:
    keyword: str
    confidence: float
    distance: float
    runner_up_confidence: float
    duration_ms: int
    accepted: bool
    reason: str


class StreamingSpeechSegmenter:
    """Small energy VAD that emits complete speech segments from PCM blocks."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.active = False
        self.speech = bytearray()
        self.pre_roll = bytearray()
        self.silence_samples = 0
        self.total_samples = 0
        if not hasattr(self, "blocks_seen"):
            self.blocks_seen = 0
        if not hasattr(self, "last_rms"):
            self.last_rms = 0.0

    @staticmethod
    def _rms(pcm: bytes) -> float:
        if len(pcm) < 2:
            return 0.0
        samples = np.frombuffer(pcm[:len(pcm) - (len(pcm) % 2)], dtype="<i2").astype(np.float32)
        if samples.size == 0:
            return 0.0
        samples /= 32768.0
        return float(np.sqrt(np.mean(samples * samples) + 1e-12))

    def feed(self, pcm: bytes) -> List[bytes]:
        if not pcm:
            return []
        usable = pcm[:len(pcm) - (len(pcm) % 2)]
        if not usable:
            return []

        rms = self._rms(usable)
        self.last_rms = rms
        self.blocks_seen += 1
        samples = len(usable) // SAMPLE_WIDTH
        emitted: List[bytes] = []

        if not self.active:
            max_pre_roll = int(PRE_ROLL_SECONDS * SAMPLE_RATE) * SAMPLE_WIDTH
            self.pre_roll.extend(usable)
            if len(self.pre_roll) > max_pre_roll:
                del self.pre_roll[:-max_pre_roll]
            if rms >= START_RMS:
                self.active = True
                self.speech = bytearray(self.pre_roll)
                self.pre_roll.clear()
                self.silence_samples = 0
                self.total_samples = len(self.speech) // SAMPLE_WIDTH
            return emitted

        self.speech.extend(usable)
        self.total_samples += samples
        if rms >= CONTINUE_RMS:
            self.silence_samples = 0
        else:
            self.silence_samples += samples

        enough_speech = self.total_samples >= int(MIN_SPEECH_SECONDS * SAMPLE_RATE)
        ended = self.silence_samples >= int(END_SILENCE_SECONDS * SAMPLE_RATE)
        too_long = self.total_samples >= int(MAX_SPEECH_SECONDS * SAMPLE_RATE)

        if enough_speech and (ended or too_long):
            trailing = self.silence_samples * SAMPLE_WIDTH if ended else 0
            segment = bytes(self.speech[:-trailing] if trailing and trailing < len(self.speech) else self.speech)
            if len(segment) >= int(MIN_SPEECH_SECONDS * SAMPLE_RATE) * SAMPLE_WIDTH:
                emitted.append(segment)
            self.reset()

        return emitted


class CustomKeywordEngine:
    """Thread-safe log-Mel + DTW template keyword recognizer."""

    def __init__(self, data_dir: Optional[str] = None) -> None:
        default_dir = Path(__file__).resolve().parents[1] / "kws-data-v2"
        self.data_dir = Path(data_dir or os.environ.get("MSD_KWS_DATA_DIR", str(default_dir)))
        self.lock = threading.RLock()
        self.templates: Dict[str, List[np.ndarray]] = {}
        self._mel_bank: Optional[np.ndarray] = None
        self.last_error: Optional[str] = None
        self.load()

    @staticmethod
    def normalize_keyword(keyword: str) -> str:
        key = (keyword or "").strip().lower().replace(" ", "_")
        if not _KEYWORD_RE.fullmatch(key):
            raise ValueError("Keyword must contain only letters, numbers, '-' or '_' and be 2-32 characters.")
        return key

    @staticmethod
    def _hz_to_mel(freq: np.ndarray | float):
        return 2595.0 * np.log10(1.0 + np.asarray(freq) / 700.0)

    @staticmethod
    def _mel_to_hz(mel: np.ndarray | float):
        return 700.0 * (np.power(10.0, np.asarray(mel) / 2595.0) - 1.0)

    def _filter_bank(self) -> np.ndarray:
        if self._mel_bank is not None:
            return self._mel_bank
        low = self._hz_to_mel(FREQ_MIN)
        high = self._hz_to_mel(FREQ_MAX)
        mel_points = np.linspace(low, high, N_MELS + 2)
        hz_points = self._mel_to_hz(mel_points)
        bins = np.floor((N_FFT + 1) * hz_points / SAMPLE_RATE).astype(int)
        bins = np.clip(bins, 0, N_FFT // 2)

        bank = np.zeros((N_MELS, N_FFT // 2 + 1), dtype=np.float32)
        for m in range(1, N_MELS + 1):
            left, center, right = bins[m - 1], bins[m], bins[m + 1]
            if center <= left:
                center = min(left + 1, N_FFT // 2)
            if right <= center:
                right = min(center + 1, N_FFT // 2)
            if center > left:
                bank[m - 1, left:center] = (
                    np.arange(left, center) - left
                ) / max(1, center - left)
            if right > center:
                bank[m - 1, center:right] = (
                    right - np.arange(center, right)
                ) / max(1, right - center)
        self._mel_bank = bank
        return bank

    @staticmethod
    def _pcm_float(pcm: bytes) -> np.ndarray:
        usable = pcm[:len(pcm) - (len(pcm) % 2)]
        if not usable:
            return np.empty(0, dtype=np.float32)
        samples = np.frombuffer(usable, dtype="<i2").astype(np.float32) / 32768.0
        if samples.size:
            samples = samples - float(np.mean(samples))
        return samples

    @staticmethod
    def _trim_energy(samples: np.ndarray) -> np.ndarray:
        if samples.size < 400:
            return samples
        frame = 320
        hop = 160
        if samples.size < frame:
            return samples
        energies = []
        starts = range(0, samples.size - frame + 1, hop)
        for start in starts:
            piece = samples[start:start + frame]
            energies.append(float(np.sqrt(np.mean(piece * piece) + 1e-12)))
        energy = np.asarray(energies, dtype=np.float32)
        peak = float(np.max(energy)) if energy.size else 0.0
        threshold = max(0.008, peak * 0.18)
        active = np.flatnonzero(energy >= threshold)
        if active.size == 0:
            return samples
        left = max(0, int(active[0]) * hop - 160)
        right = min(samples.size, int(active[-1]) * hop + frame + 160)
        return samples[left:right]

    def extract_features(self, pcm: bytes) -> np.ndarray:
        samples = self._trim_energy(self._pcm_float(pcm))
        frame_len = int(SAMPLE_RATE * FRAME_MS / 1000)
        hop_len = int(SAMPLE_RATE * HOP_MS / 1000)
        if samples.size < frame_len:
            return np.empty((0, N_MELS), dtype=np.float32)

        # Pre-emphasis emphasizes speech formant transitions and reduces low
        # frequency room hum that varies between CCTV installations.
        emphasized = np.empty_like(samples)
        emphasized[0] = samples[0]
        emphasized[1:] = samples[1:] - 0.97 * samples[:-1]

        frame_count = 1 + (emphasized.size - frame_len) // hop_len
        shape = (frame_count, frame_len)
        strides = (emphasized.strides[0] * hop_len, emphasized.strides[0])
        frames = np.lib.stride_tricks.as_strided(emphasized, shape=shape, strides=strides).copy()
        frames *= np.hanning(frame_len).astype(np.float32)

        spectrum = np.fft.rfft(frames, n=N_FFT)
        power = (np.abs(spectrum) ** 2).astype(np.float32) / N_FFT
        mel = np.maximum(power @ self._filter_bank().T, 1e-10)
        features = np.log(mel)

        # Preserve the spectral envelope that identifies phonemes. V1
        # normalized every frequency bin across the entire utterance, which
        # removed too much word identity for very short CCTV speech. V2 only
        # removes each frame's broadband level, so microphone gain changes do
        # not dominate while relative Mel-band shape remains intact.
        features -= np.mean(features, axis=1, keepdims=True)
        frame_scale = np.std(features, axis=1, keepdims=True)
        features /= np.maximum(frame_scale, 1e-3)

        # Light temporal smoothing reduces codec/block noise without delaying
        # the streaming detector.
        if len(features) >= 3:
            smoothed = features.copy()
            smoothed[1:-1] = (
                0.25 * features[:-2]
                + 0.50 * features[1:-1]
                + 0.25 * features[2:]
            )
            features = smoothed

        # Cosine-DTW then compares spectral shape rather than absolute energy.
        norms = np.linalg.norm(features, axis=1, keepdims=True)
        features /= np.maximum(norms, 1e-6)
        return features.astype(np.float32)

    @staticmethod
    def _dtw_distance(a: np.ndarray, b: np.ndarray) -> float:
        if a.size == 0 or b.size == 0:
            return float("inf")
        # Keep pathological recordings from consuming quadratic time.
        if len(a) > 260:
            a = a[np.linspace(0, len(a) - 1, 260).astype(int)]
        if len(b) > 260:
            b = b[np.linspace(0, len(b) - 1, 260).astype(int)]

        # Sakoe-Chiba band prevents unrelated sounds from matching via
        # extreme time warping while still allowing ordinary speaking-rate
        # differences. The band expands enough to connect unequal lengths.
        band = max(abs(len(a) - len(b)) + 2, int(max(len(a), len(b)) * 0.30))
        previous = np.full(len(b) + 1, np.inf, dtype=np.float32)
        previous[0] = 0.0
        for i in range(1, len(a) + 1):
            current = np.full(len(b) + 1, np.inf, dtype=np.float32)
            start = max(1, i - band)
            stop = min(len(b), i + band) + 1
            for j in range(start, stop):
                cosine_distance = max(0.0, 1.0 - float(np.dot(a[i - 1], b[j - 1])))
                current[j] = cosine_distance + min(
                    current[j - 1],
                    previous[j],
                    previous[j - 1],
                )
            previous = current
        return float(previous[-1] / max(len(a), len(b)))

    @staticmethod
    def _distance_to_confidence(distance: float) -> float:
        if not np.isfinite(distance):
            return 0.0
        # Identical templates are 1.0. Around 0.28 cosine-DTW distance maps to
        # the default 0.72 acceptance threshold; calibration can be tuned from
        # collected false-positive/false-negative data later.
        return float(np.clip(1.0 - distance, 0.0, 1.0))

    def enroll(self, keyword: str, pcm: bytes) -> dict:
        key = self.normalize_keyword(keyword)
        features = self.extract_features(pcm)
        if len(features) < 12:
            raise ValueError("Enrollment speech is too short or too quiet.")

        with self.lock:
            folder = self.data_dir / key
            folder.mkdir(parents=True, exist_ok=True)
            existing = sorted(folder.glob("*.npy"))
            if len(existing) >= MAX_TEMPLATES:
                oldest = existing[0]
                oldest.unlink(missing_ok=True)
            stamp = f"{int(time.time() * 1000)}-{os.getpid()}"
            np.save(folder / f"{stamp}.npy", features, allow_pickle=False)
            self.load()
            count = len(self.templates.get(key, []))
        return {
            "keyword": key,
            "templates": count,
            "ready": count >= MIN_TEMPLATES,
            "minimum_templates": MIN_TEMPLATES,
        }

    def clear(self, keyword: str) -> dict:
        key = self.normalize_keyword(keyword)
        with self.lock:
            folder = self.data_dir / key
            if folder.exists():
                for path in folder.glob("*.npy"):
                    path.unlink(missing_ok=True)
            self.load()
        return {"keyword": key, "templates": 0, "ready": False}

    def load(self) -> None:
        loaded: Dict[str, List[np.ndarray]] = {}
        self.last_error = None
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            for folder in self.data_dir.iterdir():
                if not folder.is_dir():
                    continue
                try:
                    key = self.normalize_keyword(folder.name)
                except ValueError:
                    continue
                items: List[np.ndarray] = []
                for path in sorted(folder.glob("*.npy"))[-MAX_TEMPLATES:]:
                    try:
                        feature = np.load(path, allow_pickle=False)
                        if feature.ndim == 2 and feature.shape[1] == N_MELS and len(feature) >= 12:
                            items.append(feature.astype(np.float32))
                    except Exception:
                        continue
                if items:
                    loaded[key] = items
        except Exception as exc:
            self.last_error = str(exc)
        self.templates = loaded

    def diagnose(self, pcm: bytes) -> Optional[KeywordDecision]:
        """Score one utterance and return the best candidate even when rejected."""
        features = self.extract_features(pcm)
        if len(features) < 12:
            return None

        ranked = []
        with self.lock:
            template_snapshot = {
                key: list(value)
                for key, value in self.templates.items()
                if len(value) >= MIN_TEMPLATES
            }

        for keyword, templates in template_snapshot.items():
            distances = sorted(self._dtw_distance(features, template) for template in templates)
            # Require agreement from two enrollment examples. Using the best
            # two is more tolerant of one unusually pronounced training sample
            # than the v1 best-three average, while a single template still
            # cannot dominate the decision.
            selected = distances[:min(2, len(distances))]
            distance = float(np.mean(selected))
            confidence = self._distance_to_confidence(distance)
            ranked.append((confidence, keyword, distance))

        if not ranked:
            return None

        ranked.sort(reverse=True)
        confidence, keyword, distance = ranked[0]
        runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
        duration_ms = round(len(pcm) / (SAMPLE_RATE * SAMPLE_WIDTH) * 1000)

        if confidence < MATCH_THRESHOLD:
            accepted = False
            reason = "below_threshold"
        elif confidence - runner_up < MATCH_MARGIN:
            accepted = False
            reason = "insufficient_margin"
        else:
            accepted = True
            reason = "accepted"

        return KeywordDecision(
            keyword=keyword,
            confidence=round(confidence, 3),
            distance=round(distance, 4),
            runner_up_confidence=round(runner_up, 3),
            duration_ms=duration_ms,
            accepted=accepted,
            reason=reason,
        )

    def match(self, pcm: bytes) -> Optional[KeywordMatch]:
        decision = self.diagnose(pcm)
        if not decision or not decision.accepted:
            return None
        return KeywordMatch(
            keyword=decision.keyword,
            confidence=decision.confidence,
            distance=decision.distance,
            runner_up_confidence=decision.runner_up_confidence,
            duration_ms=decision.duration_ms,
        )
    def has_ready_templates(self) -> bool:
        with self.lock:
            return any(len(value) >= MIN_TEMPLATES for value in self.templates.values())

    def status(self) -> dict:
        with self.lock:
            counts = {key: len(value) for key, value in sorted(self.templates.items())}
        return {
            "engine": "msds-logmel-dtw-v2",
            "feature_version": FEATURE_VERSION,
            "sample_rate": SAMPLE_RATE,
            "features": f"{N_MELS}-bin per-frame-normalized log-Mel",
            "matcher": "cosine DTW",
            "threshold": MATCH_THRESHOLD,
            "margin": MATCH_MARGIN,
            "minimum_templates": MIN_TEMPLATES,
            "keywords": counts,
            "ready_keywords": [key for key, count in counts.items() if count >= MIN_TEMPLATES],
            "suggested_keywords": list(DEFAULT_KEYWORDS),
            "data_dir": str(self.data_dir),
            "error": self.last_error,
        }


KWS_ENGINE = CustomKeywordEngine()
