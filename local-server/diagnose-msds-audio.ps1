# Read-only live CCTV audio/KWS diagnostics for the active camera.
# Run from the repo root with diagnose-msds-audio.cmd; no admin access needed.
param(
  [ValidatePattern('^slot-[0-9]+$')][string]$CameraId = "slot-1",
  [ValidateRange(10, 180)][int]$Seconds = 30
)
$ErrorActionPreference = "Stop"
$uri = "http://127.0.0.1:5000/status"
$lastBytes = $null
$lastSegments = $null
$receivedBytes = 0L
$newSegments = 0L
$lastCamera = $null
$start = Get-Date
Write-Host "[MSDS] Read-only microphone check for $CameraId. Speak a trained word 3 times." -ForegroundColor Cyan
Write-Host "[MSDS] No microphone audio is recorded, uploaded or saved." -ForegroundColor Cyan
try {
  do {
    $status = Invoke-RestMethod -Uri $uri -TimeoutSec 6
    $cam = @($status.cameras | Where-Object { $_.id -eq $CameraId } | Select-Object -First 1)
    if ($cam.Count -ne 1) {
      throw "Camera $CameraId was not found in the local server. Confirm it is connected."
    }
    $lastCamera = $cam[0]
    $audio = $lastCamera.audio
    if (-not $audio) {
      throw "Camera $CameraId has no audio status yet."
    }
    $kws = $audio.custom_kws
    $bytes = [long]$audio.bytes_received
    $segments = [long]$kws.segments_seen
    if ($null -ne $lastBytes -and $bytes -gt $lastBytes) {
      $receivedBytes += $bytes - $lastBytes
    }
    if ($null -ne $lastSegments -and $segments -gt $lastSegments) {
      $newSegments += $segments - $lastSegments
    }
    $lastBytes = $bytes
    $lastSegments = $segments
    $candidate = if ($kws.last_candidate) { $kws.last_candidate } else { "-" }
    $decision = if ($kws.last_decision) { $kws.last_decision } else { "-" }
    $sampleAt = if ($audio.last_chunk_at) { $audio.last_chunk_at } else { "none" }
    Write-Host ("[{0}] mic={1} PCM={2} source={3} VAD={4} hearing={5} noise={6} neural={7} segments={8} candidate={9} decision={10} duration_ratio={11} last_PCM={12}" -f
      (Get-Date -Format "HH:mm:ss"), $audio.connected, $bytes,
      $audio.audio_source, $kws.vad_backend, $kws.hearing_profile,
      $kws.audio_noise_profile, $kws.neural_mode, $segments,
      $candidate, $decision, $kws.last_duration_ratio, $sampleAt)
    Start-Sleep -Seconds 3
  } while (((Get-Date) - $start).TotalSeconds -lt $Seconds)
} catch {
  Write-Host "[MSDS] Diagnostic failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
$a = $lastCamera.audio
$k = $a.custom_kws
Write-Host ""
Write-Host "[MSDS] SUMMARY: newly received PCM bytes=$receivedBytes; new speech segments=$newSegments." -ForegroundColor Cyan
if (-not $a.connected -or $receivedBytes -eq 0) {
  Write-Host "[MSDS] First fix camera microphone or RTSP/MediaMTX audio. Changing sensitivity will NOT restore missing sound." -ForegroundColor Yellow
  Write-Host "[MSDS] Audio capture error: $($a.error)" -ForegroundColor Yellow
  Write-Host "[MSDS] FFmpeg audio error: $($a.ffmpeg_error)" -ForegroundColor Yellow
} elseif ($newSegments -eq 0) {
  Write-Host "[MSDS] Audio arrives but no speech segments were accepted by VAD. Test close, clear speech; maximum FFT cancellation may erase distant words." -ForegroundColor Yellow
} elseif ($k.last_decision -eq "duration_mismatch") {
  $ratio = [double]$k.last_duration_ratio
  if ($ratio -lt 0.60) {
    Write-Host "[MSDS] Last candidate segment was shorter than trained templates. Inspect lost syllable onsets and VAD segmentation." -ForegroundColor Yellow
  } elseif ($ratio -gt 1.55) {
    Write-Host "[MSDS] Last candidate segment was longer than trained templates. Inspect noise merging and extra silence." -ForegroundColor Yellow
  } else {
    Write-Host "[MSDS] Last duration rejection needs individual segment investigation; do not blindly relax the gate." -ForegroundColor Yellow
  }
} else {
  Write-Host "[MSDS] The KWS engine processed audio. Inspect each candidate decision and final visual validation separately." -ForegroundColor Green
}
Write-Host "[MSDS] The audio codec shown by the status is last-probed and may be stale after a CCTV setting change."
