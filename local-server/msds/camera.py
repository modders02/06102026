"""One fully independent pipeline per camera (video + audio + Whisper)."""
from __future__ import annotations

import glob
import json
import math
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import wave
from array import array
from dataclasses import dataclass, field
from typing import List, Optional

from .binaries import (MissingExecutable, install_hint, need_exe, no_window_flags,
                       now_iso, resolve_exe)
from .config import (AUDIO_CHUNK_SECONDS, AUDIO_ENGINE, HLS_PORT, HLS_PROBE_TTL,
                     RTSP_PORT, VIDEO_FPS, VIDEO_GOP, VIDEO_MAX_WIDTH,
                     VIDEO_THREADS, WEBRTC_PORT, match_distress)
from .whisper_engine import WHISPER
from .kws_engine import KWS_ENGINE, StreamingSpeechSegmenter

NO_AUDIO_MESSAGE = (
    "This camera's RTSP stream does not expose a usable audio track, so there is "
    "nothing to transcribe. Enable the microphone in the camera's own settings "
    "(or use an RTSP sub-stream that carries audio)."
)


def detect_scream_pcm(data: bytes) -> float:
    """Return a conservative 0..1 scream confidence from 16 kHz mono s16 PCM.

    The chunk is scanned in overlapping 0.5 s windows so a short scream is not
    diluted by several seconds of quiet audio. A positive result is never an
    alarm by itself; the renderer still requires an Angry or Frightened face
    from the same camera within the multimodal fusion window.
    """
    if len(data) < 16000:
        return 0.0
    usable = len(data) - (len(data) % 2)
    samples = array("h")
    samples.frombytes(data[:usable])
    if sys.byteorder != "little":
        samples.byteswap()

    window_size = 8000  # 0.5 s at 16 kHz
    if len(samples) < window_size:
        return 0.0

    def unit(value: float, low: float, span: float) -> float:
        return max(0.0, min(1.0, (value - low) / span))

    def score_window(window) -> float:
        peak = 0
        sum_sq = 0.0
        diff_sq = 0.0
        crossings = 0
        previous = int(window[0])
        for raw in window:
            sample = int(raw)
            absolute = abs(sample)
            if absolute > peak:
                peak = absolute
            sum_sq += sample * sample
            delta = sample - previous
            diff_sq += delta * delta
            if (sample >= 0) != (previous >= 0):
                crossings += 1
            previous = sample

        scale = 32768.0
        count = float(len(window))
        rms = math.sqrt(sum_sq / count) / scale
        peak_norm = peak / scale
        diff_rms = math.sqrt(diff_sq / max(1.0, count - 1.0)) / scale
        zcr = crossings / max(1.0, count - 1.0)
        brightness = diff_rms / max(rms, 1e-6)

        # Ordinary speech can be loud, so require both rapid crossings and
        # strong high-frequency change before publishing a scream candidate.
        if rms < 0.08 or peak_norm < 0.30 or zcr < 0.10 or brightness < 0.55:
            return 0.0

        confidence = (
            0.62
            + 0.12 * unit(rms, 0.08, 0.28)
            + 0.10 * unit(peak_norm, 0.30, 0.55)
            + 0.08 * unit(zcr, 0.10, 0.24)
            + 0.08 * unit(brightness, 0.55, 0.75)
        )
        return round(min(0.99, confidence), 3)

    best = 0.0
    hop = window_size // 2
    for offset in range(0, len(samples) - window_size + 1, hop):
        best = max(best, score_window(samples[offset:offset + window_size]))
        if best >= 0.95:
            break
    return best

def probe_streams(rtsp: str, transport: str = "tcp", timeout: int = 20) -> dict:
    """ffprobe an RTSP URL and return {ok, streams, error}."""
    ffprobe = resolve_exe("ffprobe", "FFPROBE_EXE")
    if not ffprobe:
        return {"ok": False, "streams": [], "error": install_hint("ffprobe", "FFPROBE_EXE")}
    cmd = [
        ffprobe, "-v", "error", "-rtsp_transport", transport, "-timeout", "15000000",
        "-show_entries", "stream=index,codec_type,codec_name,sample_rate,channels",
        "-of", "json", rtsp,
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                             creationflags=no_window_flags())
    except subprocess.TimeoutExpired:
        return {"ok": False, "streams": [], "error": "ffprobe timed out reaching the camera"}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "streams": [], "error": f"could not run ffprobe: {exc}"}
    if out.returncode != 0:
        return {"ok": False, "streams": [],
                "error": (out.stderr or "").strip()[:400] or "ffprobe failed"}
    try:
        streams = json.loads(out.stdout or "{}").get("streams", [])
    except json.JSONDecodeError:
        streams = []
    return {"ok": True, "streams": streams, "error": None}



@dataclass
class Camera:
    id: str
    path: str
    name: str
    rtsp: str
    enabled: bool = True

    video_proc: Optional[subprocess.Popen] = None
    audio_proc: Optional[subprocess.Popen] = None
    audio_thread: Optional[threading.Thread] = None
    stop_flag: threading.Event = field(default_factory=threading.Event)
    _audio_restart_pending: bool = False
    _audio_restart_lock: threading.Lock = field(default_factory=threading.Lock)
    restarts: int = 0
    error: Optional[str] = None
    events: List[dict] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    stderr_lines: List[str] = field(default_factory=list)
    started_at: float = 0.0
    audio_connected: bool = False
    audio_chunks: int = 0
    audio_bytes: int = 0
    audio_error: Optional[str] = None
    audio_ffmpeg_error: Optional[str] = None
    last_audio_chunk_at: Optional[str] = None
    last_transcription_at: Optional[str] = None
    last_transcript: str = ""
    # audio track discovery
    has_audio_track: Optional[bool] = None   # None = not probed yet
    audio_codec: Optional[str] = None
    audio_probe_error: Optional[str] = None
    audio_probed_at: Optional[str] = None
    audio_restarts: int = 0
    audio_source: Optional[str] = None          # which URL/transport is working
    audio_sources_tried: List[str] = field(default_factory=list)
    kws_segmenter: StreamingSpeechSegmenter = field(default_factory=StreamingSpeechSegmenter)
    kws_pending_enrollment: Optional[str] = None
    kws_enrollment_status: Optional[dict] = None
    kws_last_keyword: str = ""
    kws_last_confidence: float = 0.0
    kws_last_detected_at: Optional[str] = None
    kws_last_processing_ms: float = 0.0
    kws_segments_seen: int = 0
    kws_last_segment_at: Optional[str] = None
    kws_last_segment_ms: int = 0
    kws_last_candidate: str = ""
    kws_last_candidate_confidence: float = 0.0
    kws_last_runner_up_keyword: str = ""
    kws_last_runner_up_confidence: float = 0.0
    kws_last_keyword_scores: dict = field(default_factory=dict)
    kws_last_negative_confidence: float = 0.0
    kws_last_duration_ratio: float = 0.0
    kws_last_decision: str = ""
    _last_kws_publish_ts: float = 0.0
    _kws_enroll_suppress_until: float = 0.0

    _hls_ok: bool = False
    _hls_checked: float = 0.0

    # ---- video: RTSP -> MediaMTX (browser-compatible, low delay) ---------- #
    def _capture_video_errors(self, proc: subprocess.Popen):
        if not proc.stderr:
            return
        try:
            for raw in iter(proc.stderr.readline, b""):
                line = raw.decode("utf-8", errors="replace").strip()
                if line:
                    print(f"[FFmpeg {self.id}] {line}", flush=True)
                    with self.lock:
                        self.stderr_lines = (self.stderr_lines + [line])[-50:]
        except Exception:
            pass

    def last_video_error(self) -> str:
        with self.lock:
            return self.stderr_lines[-1] if self.stderr_lines else "RTSP stream ended"

    def _video_cmd(self, ffmpeg: str) -> List[str]:
        """Remove codec reorder/lookahead queues before WebRTC delivery.

        Copying arbitrary CCTV video preserves H265 and H264 B-frames, which
        browsers cannot reliably read over WebRTC. Opus keeps sound usable in
        WebRTC and low-latency HLS; transcription independently decodes 16 kHz
        PCM from the same local restream.
        """
        return [
            ffmpeg,
            "-nostdin", "-hide_banner", "-loglevel", "warning",
            "-fflags", "+genpts+discardcorrupt+nobuffer",
            "-flags", "low_delay", "-threads", "1",
            "-analyzeduration", "1000000", "-probesize", "262144",
            "-max_delay", "0", "-reorder_queue_size", "0",
            "-rtsp_transport", "tcp",
            "-i", self.rtsp,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", (f"scale=w='trunc(min({VIDEO_MAX_WIDTH},iw)/2)*2':h=-2:"
                    f"flags=fast_bilinear,fps={VIDEO_FPS}"),
            "-filter_threads", "1",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-crf", "23",
            "-bf", "0", "-g", str(VIDEO_GOP), "-keyint_min", str(VIDEO_GOP),
            "-sc_threshold", "0", "-threads:v", str(VIDEO_THREADS),
            "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-b:a", "64k",
            "-application", "lowdelay", "-frame_duration", "20",
            "-max_interleave_delta", "100000", "-flush_packets", "1",
            "-muxdelay", "0", "-muxpreload", "0", "-rtsp_transport", "tcp",
            "-f", "rtsp",
            f"rtsp://127.0.0.1:{RTSP_PORT}/{self.path}",
        ]

    def start_video(self):
        if self.video_proc and self.video_proc.poll() is None:
            return

        ffmpeg = need_exe("ffmpeg", "FFMPEG_EXE")
        with self.lock:
            self.stderr_lines = []
        self.error = None
        self.started_at = time.time()

        self.video_proc = subprocess.Popen(
            self._video_cmd(ffmpeg), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            creationflags=no_window_flags(),
        )
        threading.Thread(target=self._capture_video_errors,
                         args=(self.video_proc,), daemon=True).start()

    # ---- audio ------------------------------------------------------------- #
    def _audio_candidates(self) -> List[dict]:
        """Every way we know of to reach this camera's microphone.

        The republished MediaMTX stream comes first: the video pipeline already
        holds one RTSP session to the camera and many cheap cameras refuse a
        second one, which is the most common reason audio never arrives.
        """
        candidates: List[dict] = []
        if self.running():
            candidates.append({
                "label": "mediamtx",
                "url": f"rtsp://127.0.0.1:{RTSP_PORT}/{self.path}",
                "transport": "tcp",
            })
        if self.rtsp:
            candidates.append({"label": "camera-tcp", "url": self.rtsp, "transport": "tcp"})
            candidates.append({"label": "camera-udp", "url": self.rtsp, "transport": "udp"})
        return candidates

    def probe_audio(self) -> dict:
        """Detect whether this camera really exposes an audio track anywhere.

        Only a probe that succeeded and found no audio proves the camera is
        mute — a failed probe leaves `has_audio_track` unknown so capture is
        still attempted.
        """
        self.audio_probed_at = now_iso()
        candidates = self._audio_candidates()
        if not candidates:
            self.audio_probe_error = "no RTSP URL configured for this camera"
            self.has_audio_track = None
            return {"ok": False, "streams": [], "error": self.audio_probe_error}

        last_error = None
        probed_ok = False
        last_result = {"ok": False, "streams": [], "error": "not probed"}
        for cand in candidates:
            result = probe_streams(cand["url"], cand["transport"])
            last_result = result
            if not result["ok"]:
                last_error = f"{cand['label']}: {result['error']}"
                continue
            probed_ok = True
            audio = [s for s in result["streams"] if s.get("codec_type") == "audio"]
            if audio:
                self.audio_probe_error = None
                self.has_audio_track = True
                self.audio_codec = audio[0].get("codec_name")
                return result
        if probed_ok:
            # At least one probe worked and none of them saw audio.
            self.audio_probe_error = None
            self.has_audio_track = False
            self.audio_codec = None
        else:
            self.audio_probe_error = last_error
            self.has_audio_track = None
        return last_result

    def _audio_pcm_cmd(self, ffmpeg: str, cand: dict) -> List[str]:
        """Decode RTSP audio to a continuous 16 kHz mono PCM pipe.

        Do not use FFmpeg's segment muxer here. Some CCTV / MediaMTX streams
        have incomplete or irregular packet timestamps, which can leave the
        segment muxer running forever without closing a WAV file. Raw PCM is
        timestamp-independent; Python creates deterministic fixed-size WAV
        chunks for Whisper instead.
        """
        return [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "warning",
            "-rtsp_transport", cand["transport"],
            "-timeout", "15000000",
            "-i", cand["url"],
            "-vn", "-sn", "-dn",
            # `a:0` picks the first audio stream whatever its index is.
            "-map", "0:a:0",
            "-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000",
            "-f", "s16le", "pipe:1",
        ]


    def _drain_audio_stderr(self, proc: subprocess.Popen):
        if not proc.stderr:
            return
        try:
            for raw in iter(proc.stderr.readline, b""):
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                print(f"[FFmpeg audio {self.id}] {line}", flush=True)
                self.audio_ffmpeg_error = line[-500:]
        except Exception:
            pass

    def _pump_audio_stdout(self, proc: subprocess.Popen, out: "queue.Queue[bytes]") -> None:
        """Move FFmpeg PCM stdout into a queue without blocking the audio loop."""
        if not proc.stdout:
            return
        try:
            while not self.stop_flag.is_set():
                data = proc.stdout.read(4096)
                if not data:
                    break
                try:
                    out.put(data, timeout=0.5)
                except queue.Full:
                    # Whisper is temporarily slower than real time. Drop the
                    # oldest buffered block rather than deadlocking FFmpeg.
                    try:
                        out.get_nowait()
                    except queue.Empty:
                        pass
                    try:
                        out.put_nowait(data)
                    except queue.Full:
                        pass
        except Exception as exc:
            if not self.stop_flag.is_set():
                self.audio_error = f"Audio PCM reader failed: {exc}"

    def request_kws_enrollment(self, keyword: str) -> dict:
        key = KWS_ENGINE.normalize_keyword(keyword)
        self.kws_segmenter.reset()
        self.kws_pending_enrollment = key
        self._kws_enroll_suppress_until = time.time() + 8.0
        prompt = (
            "Say one NON-keyword phrase into the camera microphone."
            if key == "unknown"
            else f"Say '{key}' once into the camera microphone."
        )
        self.kws_enrollment_status = {
            "state": "waiting",
            "keyword": key,
            "message": prompt,
        }
        return dict(self.kws_enrollment_status)

    def cancel_kws_enrollment(self) -> None:
        self.kws_pending_enrollment = None
        self.kws_enrollment_status = None
        self._kws_enroll_suppress_until = 0.0
        self.kws_segmenter.reset()

    def _publish_kws_match(self, match, processing_ms: float) -> None:
        now_ts = time.time()
        if (
            match.keyword == self.kws_last_keyword
            and now_ts - self._last_kws_publish_ts < 3.0
        ):
            return
        self._last_kws_publish_ts = now_ts
        self.kws_last_keyword = match.keyword
        self.kws_last_confidence = match.confidence
        self.kws_last_detected_at = now_iso()
        self.kws_last_processing_ms = round(processing_ms, 2)
        self.last_transcription_at = self.kws_last_detected_at
        self.last_transcript = match.keyword.replace("_", " ")
        with self.lock:
            self.events.append({
                "camera_id": self.id,
                "timestamp": self.kws_last_detected_at,
                "transcript": match.keyword.replace("_", " "),
                "keyword": match.keyword.replace("_", " "),
                "confidence": match.confidence,
                "source": "custom-kws",
                "segment_ms": match.duration_ms,
                "processing_ms": self.kws_last_processing_ms,
            })
            self.events = self.events[-200:]
        print(
            f"[KWS {self.id}] {match.keyword}: {match.confidence:.2f} "
            f"({match.duration_ms} ms segment, {self.kws_last_processing_ms:.1f} ms processing)",
            flush=True,
        )

    def _process_custom_kws_pcm(self, pcm: bytes) -> None:
        if self.stop_flag.is_set():
            return
        if not self.kws_pending_enrollment and not KWS_ENGINE.has_ready_templates():
            return
        for segment in self.kws_segmenter.feed(pcm):
            if self.kws_pending_enrollment:
                key = self.kws_pending_enrollment
                self.kws_pending_enrollment = None
                try:
                    result = KWS_ENGINE.enroll(key, segment)
                    self.kws_enrollment_status = {
                        "state": "captured",
                        **result,
                        "message": (
                            f"Captured '{key}' sample {result['templates']}/"
                            f"{result['minimum_templates']}."
                        ),
                    }
                    self._kws_enroll_suppress_until = time.time() + 4.0
                    print(
                        f"[KWS {self.id}] enrolled {key}: "
                        f"{result['templates']} template(s)",
                        flush=True,
                    )
                except Exception as exc:
                    self.kws_enrollment_status = {
                        "state": "error",
                        "keyword": key,
                        "message": str(exc),
                    }
                continue

            started = time.perf_counter()
            decision = KWS_ENGINE.diagnose(segment)
            processing_ms = (time.perf_counter() - started) * 1000.0
            self.kws_segments_seen += 1
            self.kws_last_segment_at = now_iso()
            self.kws_last_segment_ms = round(len(segment) / 32.0)
            self.kws_last_processing_ms = round(processing_ms, 2)
            if decision:
                self.kws_last_candidate = decision.keyword
                self.kws_last_candidate_confidence = decision.confidence
                self.kws_last_runner_up_keyword = decision.runner_up_keyword
                self.kws_last_runner_up_confidence = decision.runner_up_confidence
                self.kws_last_keyword_scores = dict(decision.keyword_scores)
                self.kws_last_negative_confidence = decision.negative_confidence
                self.kws_last_duration_ratio = decision.duration_ratio
                self.kws_last_decision = decision.reason
                print(
                    f"[KWS {self.id}] candidate={decision.keyword} "
                    f"confidence={decision.confidence:.3f} "
                    f"unknown={decision.negative_confidence:.3f} "
                    f"runner_up={decision.runner_up_keyword or '-'}:"
                    f"{decision.runner_up_confidence:.3f} "
                    f"duration_ratio={decision.duration_ratio:.2f} "
                    f"decision={decision.reason} "
                    f"segment={decision.duration_ms}ms "
                    f"processing={processing_ms:.1f}ms",
                    flush=True,
                )
                if decision.accepted:
                    self._publish_kws_match(decision, processing_ms)
            else:
                self.kws_last_candidate = ""
                self.kws_last_candidate_confidence = 0.0
                self.kws_last_runner_up_keyword = ""
                self.kws_last_runner_up_confidence = 0.0
                self.kws_last_keyword_scores = {}
                self.kws_last_negative_confidence = 0.0
                self.kws_last_duration_ratio = 0.0
                self.kws_last_decision = "no_ready_candidate"


    def _publish_scream_if_detected(self, pcm: bytes) -> None:
        if self.stop_flag.is_set():
            return
        confidence = detect_scream_pcm(pcm)
        if confidence <= 0:
            return
        now_ts = time.time()
        if now_ts - getattr(self, "_last_scream_publish_ts", 0.0) < 6.0:
            return
        self._last_scream_publish_ts = now_ts
        timestamp = now_iso()
        with self.lock:
            self.events.append({
                "camera_id": self.id,
                "timestamp": timestamp,
                "transcript": "",
                "keyword": "scream",
                "confidence": confidence,
            })
            self.events = self.events[-200:]
        print(f"[Audio {self.id}] scream candidate: {confidence:.2f}", flush=True)

    def _handle_chunk(self, wav: str):
        if self.stop_flag.is_set():
            return
        size = os.path.getsize(wav)
        # 16 kHz mono s16 == 32 000 bytes/s; require ~0.5 s of real PCM.
        if size < 16000:
            return
        self.audio_connected = True
        self.audio_chunks += 1
        self.audio_bytes += size
        self.last_audio_chunk_at = now_iso()

        if not WHISPER.available:
            self.audio_error = WHISPER.error or "Whisper is unavailable"
            return
        try:
            transcript = WHISPER.transcribe(wav)
            if self.stop_flag.is_set():
                return
            self.audio_error = None
        except Exception as exc:
            self.audio_error = f"Whisper transcription failed: {exc}"
            self.error = self.audio_error
            return
        if not transcript:
            return

        # Overlapping RTSP chunks can return the same phrase twice in a row.
        # Only drop it within a short window — saying "help" again later must
        # still be published and raise the alarm again.
        transcript_key = " ".join(transcript.lower().split()).strip(" .,!?")
        previous_key = " ".join(self.last_transcript.lower().split()).strip(" .,!?")
        now_ts = time.time()
        if (transcript_key and transcript_key == previous_key
                and now_ts - getattr(self, "_last_publish_ts", 0.0) < 6.0):
            return
        self._last_publish_ts = now_ts

        keyword, confidence = match_distress(transcript)
        timestamp = now_iso()
        self.last_transcription_at = timestamp
        self.last_transcript = transcript

        # During KWS enrollment the spoken training word must never generate an
        # emergency. Also suppress a slower Whisper duplicate when the custom
        # engine already emitted the same keyword a few seconds earlier.
        suppress_event = time.time() < self._kws_enroll_suppress_until
        if (
            keyword
            and keyword == self.kws_last_keyword.replace("_", " ")
            and time.time() - self._last_kws_publish_ts < 6.0
        ):
            suppress_event = True

        if not suppress_event:
            with self.lock:
                self.events.append({
                    "camera_id": self.id,
                    "timestamp": timestamp,
                    "transcript": transcript,
                    "keyword": keyword,
                    "confidence": confidence,
                    "source": "whisper",
                })
                self.events = self.events[-200:]
        print(
            f"[Audio {self.id}] transcript: {transcript}"
            + (" (event suppressed by custom KWS)" if suppress_event else ""),
            flush=True,
        )

    def _audio_loop(self):
        """Continuous RTSP audio capture for custom KWS and optional Whisper.

        The custom engine consumes small PCM blocks immediately. In hybrid mode
        the same bytes are also accumulated into deterministic fixed-size WAV
        chunks for Whisper general transcription.
        """
        tmpdir = tempfile.mkdtemp(prefix=f"msd-audio-{self.path}-")
        wav_path = os.path.join(tmpdir, "live-chunk.wav")
        last_probe = 0.0
        cand_index = 0
        bytes_per_second = 16000 * 2  # mono s16le
        chunk_bytes = bytes_per_second * AUDIO_CHUNK_SECONDS
        no_pcm_timeout = max(12.0, AUDIO_CHUNK_SECONDS * 3.0)

        # Custom-only mode never loads or calls Faster-Whisper.
        if AUDIO_ENGINE != "custom":
            if WHISPER.available:
                try:
                    WHISPER.load()
                except Exception as exc:
                    self.audio_error = str(exc)
            else:
                self.audio_error = WHISPER.error or "Whisper is unavailable"

        def transcribe_pcm(data: bytes) -> None:
            if len(data) < 16000:  # less than ~0.5 s
                return
            self._publish_scream_if_detected(data)

            if AUDIO_ENGINE == "custom":
                # Keep capture diagnostics meaningful even with Whisper off.
                self.audio_connected = True
                self.audio_chunks += 1
                self.audio_bytes += len(data)
                self.last_audio_chunk_at = now_iso()
                return

            with wave.open(wav_path, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(data)
            print(
                f"[Audio {self.id}] PCM chunk {len(data)} bytes "
                f"(~{len(data) / bytes_per_second:.1f}s) -> Whisper",
                flush=True,
            )
            self._handle_chunk(wav_path)

        try:
            while not self.stop_flag.is_set():
                # 1. Confirm whether an audio track exists when possible.
                if self.has_audio_track is not True and time.time() - last_probe > 45:
                    last_probe = time.time()
                    self.probe_audio()
                if self.has_audio_track is False:
                    self.audio_connected = False
                    self.audio_error = NO_AUDIO_MESSAGE
                    self.stop_flag.wait(30)
                    continue
                if self.has_audio_track is None and self.audio_probe_error:
                    self.audio_error = (
                        f"Could not inspect the camera's audio track "
                        f"({self.audio_probe_error}); trying anyway."
                    )

                # 2. Pick the next audio source.
                candidates = self._audio_candidates()
                if not candidates:
                    self.audio_connected = False
                    self.audio_error = "No RTSP URL is configured for this camera."
                    self.stop_flag.wait(10)
                    continue
                cand = candidates[cand_index % len(candidates)]

                try:
                    ffmpeg = need_exe("ffmpeg", "FFMPEG_EXE")
                except MissingExecutable as exc:
                    self.audio_connected = False
                    self.audio_error = str(exc)
                    self.error = self.audio_error
                    self.stop_flag.wait(10)
                    continue

                try:
                    self.audio_proc = subprocess.Popen(
                        self._audio_pcm_cmd(ffmpeg, cand),
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        bufsize=0,
                        creationflags=no_window_flags(),
                    )
                except (OSError, subprocess.SubprocessError) as exc:
                    self.audio_connected = False
                    self.audio_error = (
                        f"Could not start FFmpeg audio capture: {exc}. "
                        f"{install_hint('ffmpeg', 'FFMPEG_EXE')}"
                    )
                    self.error = self.audio_error
                    self.stop_flag.wait(10)
                    continue

                self.audio_ffmpeg_error = None
                self.audio_source = cand["label"]
                if cand["label"] not in self.audio_sources_tried:
                    self.audio_sources_tried.append(cand["label"])
                print(
                    f"[Audio {self.id}] capturing PCM from {cand['label']} ({cand['url']})",
                    flush=True,
                )
                chunks_before = self.audio_chunks

                threading.Thread(
                    target=self._drain_audio_stderr,
                    args=(self.audio_proc,),
                    daemon=True,
                ).start()

                pcm_queue: "queue.Queue[bytes]" = queue.Queue(maxsize=256)
                threading.Thread(
                    target=self._pump_audio_stdout,
                    args=(self.audio_proc, pcm_queue),
                    daemon=True,
                ).start()

                pcm = bytearray()
                self.kws_segmenter.reset()
                last_pcm_at = time.time()

                # 3. Build deterministic fixed-size chunks from raw PCM.
                while not self.stop_flag.is_set() and self.audio_proc.poll() is None:
                    try:
                        block = pcm_queue.get(timeout=0.5)
                        if block:
                            self._process_custom_kws_pcm(block)
                            pcm.extend(block)
                            last_pcm_at = time.time()
                    except queue.Empty:
                        pass

                    while len(pcm) >= chunk_bytes and not self.stop_flag.is_set():
                        chunk = bytes(pcm[:chunk_bytes])
                        del pcm[:chunk_bytes]
                        try:
                            transcribe_pcm(chunk)
                            self.audio_error = None
                        except Exception as exc:
                            self.audio_error = f"Audio chunk failed: {exc}"

                    # FFmpeg can remain connected to an RTSP stream that contains
                    # no audio packets. Rotate sources instead of waiting forever.
                    if (
                        self.audio_chunks == chunks_before
                        and time.time() - last_pcm_at > no_pcm_timeout
                    ):
                        self.audio_ffmpeg_error = (
                            self.audio_ffmpeg_error
                            or f"no PCM audio received for {int(no_pcm_timeout)} seconds"
                        )
                        try:
                            self.audio_proc.terminate()
                        except Exception:
                            pass
                        break

                if self.stop_flag.is_set():
                    break

                # Process a useful final partial chunk before switching sources.
                if len(pcm) >= 16000:
                    try:
                        transcribe_pcm(bytes(pcm))
                    except Exception as exc:
                        self.audio_error = f"Audio chunk failed: {exc}"

                code = self.audio_proc.poll()
                produced = self.audio_chunks > chunks_before
                self.audio_connected = False
                self.audio_restarts += 1
                detail = self.audio_ffmpeg_error or "no details"
                if not produced:
                    cand_index += 1
                    nxt = candidates[cand_index % len(candidates)]["label"]
                    self.audio_error = (
                        f"No audio from {cand['label']} (exit {code}): {detail}. "
                        f"Trying {nxt}…"
                    )
                elif code not in (0, None):
                    self.audio_error = (
                        f"FFmpeg audio capture stopped (exit {code}): {detail}. "
                        "Reconnecting…"
                    )
                else:
                    self.audio_error = "Camera audio stream ended; reconnecting…"

                self.has_audio_track = None
                last_probe = 0.0
                self.stop_flag.wait(2)
        finally:
            self.audio_connected = False
            if self.audio_proc and self.audio_proc.poll() is None:
                try:
                    self.audio_proc.terminate()
                    self.audio_proc.wait(timeout=5)
                except Exception:
                    self.audio_proc.kill()
            shutil.rmtree(tmpdir, ignore_errors=True)

    def audio_test(self) -> dict:
        """One-shot diagnostic: probe the streams, then try to grab a short WAV
        from every audio source in turn and transcribe the first good one."""
        report: dict = {
            "camera_id": self.id,
            "recognition_engine": AUDIO_ENGINE,
            "rtsp": self.rtsp,
            "rtsp_configured": bool(self.rtsp),
            "probe": None,
            "attempts": [],
            "capture": None,
            "source": None,
            "whisper": {
                "available": WHISPER.available,
                "state": WHISPER.state,
                "error": WHISPER.error,
            },
            "transcript": "",
            "success": False,
            "error": None,
        }
        if not self.rtsp:
            report["error"] = "no RTSP URL configured for this camera"
            return report

        probe = self.probe_audio()
        report["probe"] = {
            "ok": probe["ok"],
            "error": probe["error"],
            "has_audio_track": self.has_audio_track,
            "audio_codec": self.audio_codec,
            "streams": probe["streams"],
        }
        if self.has_audio_track is False:
            report["error"] = NO_AUDIO_MESSAGE
            return report

        try:
            ffmpeg = need_exe("ffmpeg", "FFMPEG_EXE")
        except MissingExecutable as exc:
            report["error"] = str(exc)
            return report

        tmpdir = tempfile.mkdtemp(prefix=f"msd-audiotest-{self.path}-")
        good_wav = None
        try:
            for cand in self._audio_candidates():
                wav = os.path.join(tmpdir, f"test-{cand['label']}.wav")
                attempt = {"source": cand["label"], "url": cand["url"],
                           "transport": cand["transport"], "returncode": None,
                           "bytes": 0, "seconds": 0.0, "ffmpeg_error": None}
                try:
                    out = subprocess.run(
                        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
                         "-rtsp_transport", cand["transport"], "-timeout", "15000000",
                         "-i", cand["url"], "-vn", "-map", "0:a:0",
                         "-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000",
                         "-t", "5", "-f", "wav", "-y", wav],
                        capture_output=True, text=True, timeout=40,
                        creationflags=no_window_flags(),
                    )
                    size = os.path.getsize(wav) if os.path.exists(wav) else 0
                    attempt.update({
                        "returncode": out.returncode,
                        "bytes": size,
                        "seconds": round(max(0, size - 44) / 32000, 2),
                        "ffmpeg_error": (out.stderr or "").strip()[-500:] or None,
                    })
                    report["attempts"].append(attempt)
                    if out.returncode == 0 and size >= 16000:
                        good_wav = wav
                        report["capture"] = attempt
                        report["source"] = cand["label"]
                        break
                except subprocess.TimeoutExpired:
                    attempt["ffmpeg_error"] = "timed out capturing audio"
                    report["attempts"].append(attempt)
                except Exception as exc:
                    attempt["ffmpeg_error"] = str(exc)
                    report["attempts"].append(attempt)

            if not good_wav:
                worst = next((a["ffmpeg_error"] for a in reversed(report["attempts"])
                              if a.get("ffmpeg_error")), None)
                report["error"] = worst or "no usable audio captured from any source"
                return report
            if AUDIO_ENGINE == "custom":
                with wave.open(good_wav, "rb") as wav_file:
                    pcm_data = wav_file.readframes(wav_file.getnframes())
                segmenter = StreamingSpeechSegmenter()
                segments = []
                for offset in range(0, len(pcm_data), 4096):
                    segments.extend(segmenter.feed(pcm_data[offset:offset + 4096]))
                matches = []
                for segment in segments:
                    match = KWS_ENGINE.match(segment)
                    if match:
                        matches.append(match)
                best = max(matches, key=lambda item: item.confidence) if matches else None
                report["custom_kws"] = {
                    **KWS_ENGINE.status(),
                    "segments": len(segments),
                    "match": ({
                        "keyword": best.keyword,
                        "confidence": best.confidence,
                        "distance": best.distance,
                        "runner_up_confidence": best.runner_up_confidence,
                        "duration_ms": best.duration_ms,
                    } if best else None),
                }
                report["transcript"] = best.keyword.replace("_", " ") if best else ""
                report["success"] = True
                return report

            if not WHISPER.available:
                report["error"] = WHISPER.error or "Whisper is unavailable"
                return report
            report["transcript"] = WHISPER.transcribe(good_wav)
            report["whisper"]["state"] = WHISPER.state
            report["success"] = True
        except Exception as exc:
            report["error"] = str(exc)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
        return report


    # ---- lifecycle --------------------------------------------------------- #
    def _restart_audio_after(self, previous_audio: threading.Thread) -> None:
        """Finish the previous audio worker, then restart if the slot is live.

        In hybrid mode Faster-Whisper inference is not safely cancellable
        mid-call. Reconnect therefore waits in a daemon thread instead of
        clearing stop_flag while the old worker is still running.
        """
        try:
            previous_audio.join()
            with self._audio_restart_lock:
                if self.audio_thread is previous_audio:
                    self.audio_thread = None
                self._audio_restart_pending = False
                if not self.enabled:
                    return
                self.stop_flag.clear()
                self.start_audio()
        except Exception as exc:
            with self._audio_restart_lock:
                self._audio_restart_pending = False
                if self.enabled:
                    self.audio_error = f"Could not restart camera audio: {exc}"

    def _defer_audio_restart(self, previous_audio: threading.Thread) -> None:
        with self._audio_restart_lock:
            if self._audio_restart_pending:
                return
            self._audio_restart_pending = True
        threading.Thread(
            target=self._restart_audio_after,
            args=(previous_audio,),
            daemon=True,
        ).start()

    def start(self):
        self.error = None
        # Video does not share the Whisper worker's stop lifecycle, so restore
        # it immediately even when audio is still finishing an old chunk.
        self.start_video()

        previous_audio = self.audio_thread
        if previous_audio and previous_audio.is_alive():
            if self.stop_flag.is_set():
                self._defer_audio_restart(previous_audio)
            # If stop_flag is clear this is simply an already-running camera.
            return

        with self._audio_restart_lock:
            self.audio_thread = None
            self._audio_restart_pending = False
            self.stop_flag.clear()
        self.start_audio()

    def start_audio(self):
        """Audio capture runs whenever the camera is enabled — even if Whisper
        is broken — so the diagnostics can tell capture apart from transcription."""
        if self.stop_flag.is_set():
            return
        if self.audio_thread and self.audio_thread.is_alive():
            return
        self.audio_thread = threading.Thread(target=self._audio_loop, daemon=True)
        self.audio_thread.start()

    def stop(self):
        # Serialize against the deferred restart so a late waiter can never
        # clear stop_flag after the user has disconnected the camera again.
        with self._audio_restart_lock:
            self.stop_flag.set()
        audio_thread = self.audio_thread
        for proc in (self.video_proc, self.audio_proc):
            if proc and proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()

        # A rapid Reconnect must not clear stop_flag while the previous audio
        # worker is still alive, otherwise the old worker can resume beside the
        # new one. Wait for this camera's worker only; other slots are untouched.
        if (audio_thread and audio_thread is not threading.current_thread()
                and audio_thread.is_alive()):
            audio_thread.join(timeout=5)

        self.video_proc = None
        self.audio_proc = None
        self.audio_thread = audio_thread if audio_thread and audio_thread.is_alive() else None
        if self.audio_thread is None:
            with self._audio_restart_lock:
                self._audio_restart_pending = False
        self.audio_connected = False
        self.audio_chunks = 0
        self.audio_bytes = 0
        self.audio_error = None
        self.audio_ffmpeg_error = None
        self.last_audio_chunk_at = None
        self.last_transcription_at = None
        self.last_transcript = ""
        self.audio_source = None
        self.audio_sources_tried = []
        self.has_audio_track = None
        self.audio_codec = None
        self.audio_probe_error = None
        self.audio_probed_at = None
        self._last_publish_ts = 0.0
        self._last_scream_publish_ts = 0.0
        self.kws_segmenter.reset()
        self.kws_pending_enrollment = None
        self.kws_enrollment_status = None
        self.kws_last_keyword = ""
        self.kws_last_confidence = 0.0
        self.kws_last_detected_at = None
        self.kws_last_processing_ms = 0.0
        self.kws_segments_seen = 0
        self.kws_last_segment_at = None
        self.kws_last_segment_ms = 0
        self.kws_last_candidate = ""
        self.kws_last_candidate_confidence = 0.0
        self.kws_last_runner_up_keyword = ""
        self.kws_last_runner_up_confidence = 0.0
        self.kws_last_keyword_scores = {}
        self.kws_last_negative_confidence = 0.0
        self.kws_last_duration_ratio = 0.0
        self.kws_last_decision = ""
        self._last_kws_publish_ts = 0.0
        self._kws_enroll_suppress_until = 0.0
        with self.lock:
            self.events = []
        self._hls_ok = False
        self._hls_checked = 0.0

    def running(self) -> bool:
        return bool(self.video_proc and self.video_proc.poll() is None)

    def hls_ready(self, force: bool = False) -> bool:
        if not self.running():
            self._hls_ok = False
            return False
        now = time.time()
        if not force and self._hls_ok and now - self._hls_checked < HLS_PROBE_TTL:
            return True
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{HLS_PORT}/{self.path}/index.m3u8", timeout=1.5
            ) as response:
                self._hls_ok = response.status == 200 and b"#EXTM3U" in response.read(128)
        except Exception:
            self._hls_ok = False
        self._hls_checked = now
        return self._hls_ok

    def status(self, host: str) -> dict:
        return {
            "id": self.id,
            "path": self.path,
            "name": self.name,
            "enabled": self.enabled,
            "ffmpeg": self.running(),
            "hls_ready": self.hls_ready(),
            "stream": f"http://{host}:{HLS_PORT}/{self.path}/index.m3u8",
            "stream_local": f"http://127.0.0.1:{HLS_PORT}/{self.path}/index.m3u8",
            "webrtc": f"http://{host}:{WEBRTC_PORT}/{self.path}/whep",
            "webrtc_local": f"http://127.0.0.1:{WEBRTC_PORT}/{self.path}/whep",
            "restarts": self.restarts,
            "error": self.error,
            "audio": self.audio_status(),
        }

    def audio_status(self) -> dict:
        thread_running = bool(self.audio_thread and self.audio_thread.is_alive())
        error = self.audio_error
        if self.has_audio_track is False:
            error = NO_AUDIO_MESSAGE
        elif not thread_running and not error:
            error = "Audio worker is not running; start the camera to begin listening."
        return {
            "thread_running": thread_running,
            "connected": self.audio_connected,
            "capturing": bool(self.audio_proc and self.audio_proc.poll() is None),
            "chunks_received": self.audio_chunks,
            "bytes_received": self.audio_bytes,
            "seconds_captured": round(max(0, self.audio_bytes) / 32000, 1),
            "last_chunk_at": self.last_audio_chunk_at,
            "last_transcription_at": self.last_transcription_at,
            "last_transcript": self.last_transcript,
            "has_audio_track": self.has_audio_track,
            "audio_codec": self.audio_codec,
            "audio_probe_error": self.audio_probe_error,
            "audio_probed_at": self.audio_probed_at,
            "audio_restarts": self.audio_restarts,
            "audio_source": self.audio_source,
            "audio_sources_tried": list(self.audio_sources_tried),
            "chunk_seconds": AUDIO_CHUNK_SECONDS,
            "recognition_engine": AUDIO_ENGINE,
            "custom_kws": {
                **KWS_ENGINE.status(),
                "pending_enrollment": self.kws_pending_enrollment,
                "enrollment": self.kws_enrollment_status,
                "vad_active": self.kws_segmenter.active,
                "vad_last_rms": round(self.kws_segmenter.last_rms, 5),
                "vad_start_threshold": 0.025,
                "vad_continue_threshold": 0.015,
                "segments_seen": self.kws_segments_seen,
                "last_segment_at": self.kws_last_segment_at,
                "last_segment_ms": self.kws_last_segment_ms,
                "last_candidate": self.kws_last_candidate or None,
                "last_candidate_confidence": self.kws_last_candidate_confidence,
                "last_runner_up_keyword": self.kws_last_runner_up_keyword or None,
                "last_runner_up_confidence": self.kws_last_runner_up_confidence,
                "last_keyword_scores": dict(self.kws_last_keyword_scores),
                "last_negative_confidence": self.kws_last_negative_confidence,
                "last_duration_ratio": self.kws_last_duration_ratio,
                "last_decision": self.kws_last_decision or None,
                "last_keyword": self.kws_last_keyword or None,
                "last_confidence": self.kws_last_confidence,
                "last_detected_at": self.kws_last_detected_at,
                "last_processing_ms": self.kws_last_processing_ms,
            },
            "whisper_available": WHISPER.available,
            "whisper_state": WHISPER.state,
            "whisper_model": WHISPER.model_name,
            "whisper_error": WHISPER.error,
            "error": error or (WHISPER.error if AUDIO_ENGINE != "custom" else None),
            "ffmpeg_error": self.audio_ffmpeg_error,
        }
