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
FEATURE_VERSION = "logmel-shape-dtw-v3-open-set"
NEGATIVE_CLASS = "unknown"
MIN_TEMPLATES = 3
MIN_NEGATIVE_TEMPLATES = 5
MAX_TEMPLATES = 10
MAX_NEGATIVE_TEMPLATES = 40
MATCH_THRESHOLD = 0.70
MATCH_MARGIN = 0.06
OPEN_SET_MARGIN = 0.03
MIN_DURATION_RATIO = 0.60
MAX_DURATION_RATIO = 1.55

# V4 matcher weights. Existing v2/v3 enrollment templates remain compatible:
# temporal/delta representations are derived from the stored log-Mel frames.
SEQUENCE_STEPS = 12
DTW_WEIGHT = 0.45
SEQUENCE_WEIGHT = 0.35
DELTA_WEIGHT = 0.20
DURATION_DISTANCE_WEIGHT = 0.04
PRIMARY_MATCHER = "v3_dtw"

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
    runner_up_keyword: str
    runner_up_confidence: float
    keyword_scores: Dict[str, float]
    keyword_duration_ratios: Dict[str, float]
    negative_confidence: float
    duration_ratio: float
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

    @staticmethod
    def _resample_sequence(features: np.ndarray, steps: int = SEQUENCE_STEPS) -> np.ndarray:
        """Resample a word to fixed relative-time positions without changing templates."""
        if features.size == 0:
            return np.empty((0, N_MELS), dtype=np.float32)
        if len(features) == 1:
            return np.repeat(features, steps, axis=0).astype(np.float32)
        positions = np.linspace(0.0, len(features) - 1.0, steps, dtype=np.float32)
        left = np.floor(positions).astype(int)
        right = np.minimum(left + 1, len(features) - 1)
        alpha = (positions - left).reshape(-1, 1)
        sampled = features[left] * (1.0 - alpha) + features[right] * alpha
        norms = np.linalg.norm(sampled, axis=1, keepdims=True)
        sampled /= np.maximum(norms, 1e-6)
        return sampled.astype(np.float32)

    @staticmethod
    def _delta_sequence(features: np.ndarray) -> np.ndarray:
        """Centered spectral motion; emphasizes phoneme transitions and ordering."""
        if len(features) < 2:
            return np.zeros_like(features, dtype=np.float32)
        delta = np.zeros_like(features, dtype=np.float32)
        delta[0] = features[1] - features[0]
        delta[-1] = features[-1] - features[-2]
        if len(features) > 2:
            delta[1:-1] = 0.5 * (features[2:] - features[:-2])
        norms = np.linalg.norm(delta, axis=1, keepdims=True)
        active = norms[:, 0] > 1e-5
        delta[active] /= norms[active]
        return delta

    @staticmethod
    def _aligned_cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
        if a.size == 0 or b.size == 0 or len(a) != len(b):
            return float("inf")
        norm_a = np.linalg.norm(a, axis=1)
        norm_b = np.linalg.norm(b, axis=1)
        both_quiet = (norm_a <= 1e-6) & (norm_b <= 1e-6)
        dots = np.sum(a * b, axis=1)
        distances = 1.0 - np.clip(dots, -1.0, 1.0)
        # For delta features, two frames with no spectral motion agree.
        distances[both_quiet] = 0.0
        return float(np.mean(distances))

    def _sequence_distance(self, a: np.ndarray, b: np.ndarray) -> float:
        """V4 distance: DTW + relative-time spectral shape + spectral motion."""
        if a.size == 0 or b.size == 0:
            return float("inf")

        dtw = self._dtw_distance(a, b)
        a_fixed = self._resample_sequence(a)
        b_fixed = self._resample_sequence(b)
        aligned = self._aligned_cosine_distance(a_fixed, b_fixed)

        a_delta = self._delta_sequence(a_fixed)
        b_delta = self._delta_sequence(b_fixed)
        delta = self._aligned_cosine_distance(a_delta, b_delta)

        ratio = max(len(a), 1) / max(len(b), 1)
        duration_penalty = min(
            0.08,
            DURATION_DISTANCE_WEIGHT * abs(float(np.log(max(ratio, 1e-6)))),
        )
        return float(
            DTW_WEIGHT * dtw
            + SEQUENCE_WEIGHT * aligned
            + DELTA_WEIGHT * delta
            + duration_penalty
        )

    def enroll(self, keyword: str, pcm: bytes) -> dict:
        key = self.normalize_keyword(keyword)
        features = self.extract_features(pcm)
        if len(features) < 12:
            raise ValueError("Enrollment speech is too short or too quiet.")

        with self.lock:
            folder = self.data_dir / key
            folder.mkdir(parents=True, exist_ok=True)
            existing = sorted(folder.glob("*.npy"))
            maximum = MAX_NEGATIVE_TEMPLATES if key == NEGATIVE_CLASS else MAX_TEMPLATES
            if len(existing) >= maximum:
                oldest = existing[0]
                oldest.unlink(missing_ok=True)
            stamp = f"{int(time.time() * 1000)}-{os.getpid()}"
            np.save(folder / f"{stamp}.npy", features, allow_pickle=False)
            self.load()
            count = len(self.templates.get(key, []))
        minimum = MIN_NEGATIVE_TEMPLATES if key == NEGATIVE_CLASS else MIN_TEMPLATES
        return {
            "keyword": key,
            "templates": count,
            "ready": count >= minimum,
            "minimum_templates": minimum,
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
                maximum = MAX_NEGATIVE_TEMPLATES if key == NEGATIVE_CLASS else MAX_TEMPLATES
                for path in sorted(folder.glob("*.npy"))[-maximum:]:
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
        """Open-set keyword decision: target must beat trained non-keyword speech."""
        features = self.extract_features(pcm)
        if len(features) < 12:
            return None

        with self.lock:
            positive_snapshot = {
                key: list(value)
                for key, value in self.templates.items()
                if key != NEGATIVE_CLASS and len(value) >= MIN_TEMPLATES
            }
            negative_templates = list(self.templates.get(NEGATIVE_CLASS, []))

        ranked = []
        target_lengths = {}
        for keyword, templates in positive_snapshot.items():
            # The real enrollment audit favored the original constrained DTW
            # matcher over the experimental v4 sequence matcher (14/18 vs
            # 12/18 leave-one-out correct). Keep v4 available in /kws/evaluate,
            # but use the stronger measured baseline for live recognition.
            distances = sorted(self._dtw_distance(features, template) for template in templates)
            selected = distances[:min(2, len(distances))]
            distance = float(np.mean(selected))
            confidence = self._distance_to_confidence(distance)
            median_frames = float(np.median([len(template) for template in templates]))
            duration_ratio = len(features) / max(1.0, median_frames)
            target_lengths[keyword] = duration_ratio
            ranked.append((confidence, keyword, distance))

        if not ranked:
            return None

        ranked.sort(reverse=True)
        confidence, keyword, distance = ranked[0]
        runner_up_keyword = ranked[1][1] if len(ranked) > 1 else ""
        runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
        keyword_scores = {
            item_keyword: round(item_confidence, 3)
            for item_confidence, item_keyword, _ in ranked
        }
        keyword_duration_ratios = {
            item_keyword: round(target_lengths[item_keyword], 3)
            for _, item_keyword, _ in ranked
        }
        duration_ratio = target_lengths[keyword]
        duration_ms = round(len(pcm) / (SAMPLE_RATE * SAMPLE_WIDTH) * 1000)

        negative_ready = len(negative_templates) >= MIN_NEGATIVE_TEMPLATES
        negative_confidence = 0.0
        if negative_ready:
            # A single close hard-negative example is enough to veto a keyword.
            negative_distance = min(
                self._dtw_distance(features, template) for template in negative_templates
            )
            negative_confidence = self._distance_to_confidence(negative_distance)

        if not negative_ready:
            accepted = False
            reason = "negative_not_ready"
        elif duration_ratio < MIN_DURATION_RATIO or duration_ratio > MAX_DURATION_RATIO:
            accepted = False
            reason = "duration_mismatch"
        elif confidence < MATCH_THRESHOLD:
            accepted = False
            reason = "below_threshold"
        elif negative_confidence >= confidence - OPEN_SET_MARGIN:
            # Require the target to beat the closest trained non-keyword by a
            # small but real margin. Real CCTV measurements showed genuine
            # "help" at +0.041 over UNKNOWN while "hello" had UNKNOWN ahead,
            # so 0.03 preserves that separation without forcing false rejects.
            accepted = False
            reason = "too_close_to_unknown"
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
            runner_up_keyword=runner_up_keyword,
            runner_up_confidence=round(runner_up, 3),
            keyword_scores=keyword_scores,
            keyword_duration_ratios=keyword_duration_ratios,
            negative_confidence=round(negative_confidence, 3),
            duration_ratio=round(duration_ratio, 3),
            duration_ms=duration_ms,
            accepted=accepted,
            reason=reason,
        )
    def evaluate_templates(self) -> dict:
        """Leave-one-template-out audit for v3 DTW and v4 sequence scoring.

        This uses only stored enrollment features and never changes templates.
        Each positive template is classified while excluding itself from its
        own class, exposing cross-keyword confusion before live thresholds are
        tuned.
        """
        with self.lock:
            snapshot = {
                key: list(value)
                for key, value in self.templates.items()
            }

        positives = {
            key: value
            for key, value in snapshot.items()
            if key != NEGATIVE_CLASS and len(value) >= MIN_TEMPLATES
        }
        negatives = list(snapshot.get(NEGATIVE_CLASS, []))

        duration_summary = {}
        for key, templates in positives.items():
            lengths = [len(item) for item in templates]
            duration_summary[key] = {
                "templates": len(lengths),
                "median_frames": round(float(np.median(lengths)), 1),
                "min_frames": int(min(lengths)),
                "max_frames": int(max(lengths)),
            }

        def evaluate_mode(mode: str) -> dict:
            distance_fn = self._dtw_distance if mode == "v3_dtw" else self._sequence_distance
            vote_count = 2 if mode == "v3_dtw" else 3
            samples = []
            confusion = {
                key: {other: 0 for other in positives}
                for key in positives
            }
            by_keyword = {
                key: {"tested": 0, "correct": 0, "margins": []}
                for key in positives
            }

            for true_key, true_templates in positives.items():
                for held_index, query in enumerate(true_templates):
                    ranked = []
                    duration_ratios = {}
                    for candidate, candidate_templates in positives.items():
                        pool = [
                            template
                            for index, template in enumerate(candidate_templates)
                            if not (candidate == true_key and index == held_index)
                        ]
                        if not pool:
                            continue
                        distances = sorted(distance_fn(query, template) for template in pool)
                        selected = distances[:min(vote_count, len(distances))]
                        distance = float(np.mean(selected))
                        confidence = self._distance_to_confidence(distance)
                        median_frames = float(np.median([len(template) for template in pool]))
                        duration_ratios[candidate] = len(query) / max(1.0, median_frames)
                        ranked.append((confidence, candidate, distance))

                    if not ranked:
                        continue
                    ranked.sort(reverse=True)
                    confidence, predicted, distance = ranked[0]
                    runner_keyword = ranked[1][1] if len(ranked) > 1 else ""
                    runner_confidence = ranked[1][0] if len(ranked) > 1 else 0.0
                    margin = confidence - runner_confidence
                    negative_confidence = 0.0
                    if negatives:
                        negative_distance = min(distance_fn(query, item) for item in negatives)
                        negative_confidence = self._distance_to_confidence(negative_distance)

                    correct = predicted == true_key
                    confusion[true_key][predicted] += 1
                    by_keyword[true_key]["tested"] += 1
                    by_keyword[true_key]["correct"] += int(correct)
                    by_keyword[true_key]["margins"].append(margin)
                    samples.append({
                        "true_keyword": true_key,
                        "template_index": held_index + 1,
                        "predicted_keyword": predicted,
                        "correct": correct,
                        "confidence": round(confidence, 3),
                        "runner_up_keyword": runner_keyword or None,
                        "runner_up_confidence": round(runner_confidence, 3),
                        "margin": round(margin, 3),
                        "unknown_confidence": round(negative_confidence, 3),
                        "unknown_gap": round(confidence - negative_confidence, 3),
                        "duration_ratio": round(duration_ratios.get(predicted, 0.0), 3),
                    })

            total = len(samples)
            correct_count = sum(1 for item in samples if item["correct"])
            summary = {}
            for key, values in by_keyword.items():
                tested = values["tested"]
                correct = values["correct"]
                margins = values.pop("margins")
                summary[key] = {
                    "tested": tested,
                    "correct": correct,
                    "accuracy": round(correct / tested, 3) if tested else 0.0,
                    "mean_top_margin": round(float(np.mean(margins)), 3) if margins else 0.0,
                    "min_top_margin": round(float(np.min(margins)), 3) if margins else 0.0,
                }

            return {
                "mode": mode,
                "total": total,
                "correct": correct_count,
                "accuracy": round(correct_count / total, 3) if total else 0.0,
                "by_keyword": summary,
                "confusion": confusion,
                "samples": samples,
            }

        return {
            "success": True,
            "feature_version": FEATURE_VERSION,
            "positive_keywords": sorted(positives),
            "negative_templates": len(negatives),
            "duration_summary": duration_summary,
            "v3_dtw": evaluate_mode("v3_dtw"),
            "v4_sequence": evaluate_mode("v4_sequence"),
        }

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
            return any(
                key != NEGATIVE_CLASS and len(value) >= MIN_TEMPLATES
                for key, value in self.templates.items()
            )

    def status(self) -> dict:
        with self.lock:
            counts = {key: len(value) for key, value in sorted(self.templates.items())}
        return {
            "engine": "msds-logmel-dtw-v3",
            "feature_version": FEATURE_VERSION,
            "sample_rate": SAMPLE_RATE,
            "features": f"{N_MELS}-bin per-frame-normalized log-Mel",
            "matcher": "cosine DTW",
            "primary_matcher": PRIMARY_MATCHER,
            "experimental_matcher": "v4_sequence (audit only)",
            "threshold": MATCH_THRESHOLD,
            "margin": MATCH_MARGIN,
            "open_set_margin": OPEN_SET_MARGIN,
            "minimum_templates": MIN_TEMPLATES,
            "minimum_negative_templates": MIN_NEGATIVE_TEMPLATES,
            "keywords": counts,
            "negative_class": NEGATIVE_CLASS,
            "negative_templates": counts.get(NEGATIVE_CLASS, 0),
            "negative_ready": counts.get(NEGATIVE_CLASS, 0) >= MIN_NEGATIVE_TEMPLATES,
            "open_set_ready": (
                counts.get(NEGATIVE_CLASS, 0) >= MIN_NEGATIVE_TEMPLATES
                and any(
                    key != NEGATIVE_CLASS and count >= MIN_TEMPLATES
                    for key, count in counts.items()
                )
            ),
            "ready_keywords": [
                key for key, count in counts.items()
                if key != NEGATIVE_CLASS and count >= MIN_TEMPLATES
            ],
            "suggested_keywords": list(DEFAULT_KEYWORDS),
            "data_dir": str(self.data_dir),
            "error": self.last_error,
        }


KWS_ENGINE = CustomKeywordEngine()
