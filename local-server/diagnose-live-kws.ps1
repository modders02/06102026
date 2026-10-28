# Read-only live MSDS CCTV microphone / KWS diagnostic.
# Does NOT change microphone gain, camera credentials, alerts or enrollment.
param(
  [string]$CameraId = "slot-1",
  [ValidateRange(10, 180)][int]$Seconds = 40,
  [ValidateRange(1, 10)][int]$EverySeconds = 2
)
$ErrorActionPreference = "Stop"
$url = "http://127.0.0.1:5000/status"
$stopAt = (Get-Date).AddSeconds($Seconds)
$baselineBytes = $null
$baselineSegments = $null
$baselineDrops = $null
$seen = @{}
$lastCam = $null
Write-Host "[MSDS] CCTV listening diagnostic. Speak HELP, FIRE, EMERGENCY clearly at 1-2 meters." -ForegroundColor Cyan
Write-Host "[MSDS] No audio is recorded, sent anywhere, or saved. Camera ID: $CameraId" -ForegroundColor Cyan
try {
  do {
    $status = Invoke-RestMethod -Uri $url -TimeoutSec 4
    $cam = @($status.cameras | Where-Object { $_.id -eq $CameraId } | Select-Object -First 1)
    if ($cam.Count -eq 0) {
      throw "Camera '$CameraId' not present. Check Camera 1 is enabled and the local server is running."
    }
    $lastCam = $cam[0]
    $audio = $lastCam.audio
    $kws = $audio.custom_kws
    if ($null -eq $baselineBytes) {
      $baselineBytes = [long]$audio.bytes_received
      $baselineSegments = [long]$kws.segments_seen
      $baselineDrops = [long]$kws.vad_max_length_drops
    }
    $decision = if ($kws.last_decision) { [string]$kws.last_decision } else { "-" }
    $candidate = if ($kws.last_candidate) { [string]$kws.last_candidate } else { "-" }
    $key = "$($kws.last_segment_at)|$decision|$candidate"
    if ($kws.last_segment_at -and -not $seen.ContainsKey($key)) { $seen[$key] = $true }
    $now = Get-Date -Format "HH:mm:ss"
    $msg = ("[{0}] connected={1} bytes={2} source={3} RMS={4:N4} floor={5:N4} gate={6:N4} vad={7} active={8} segments={9} word={10} decision={11} neural={12}" -f `
      $now, $audio.connected, $audio.bytes_received, $audio.audio_source,
      [double]$kws.vad_last_rms, [double]$kws.vad_noise_floor_rms,
      [double]$kws.vad_speech_energy_gate, $kws.vad_backend,
      $kws.vad_active, $kws.segments_seen, $candidate, $decision, $kws.neural_mode)
    Write-Host $msg
    Start-Sleep -Seconds $EverySeconds
  } while ((Get-Date) -lt $stopAt)
} catch {
  Write-Host "[MSDS] Diagnostic stopped: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
$audio = $lastCam.audio
$kws = $audio.custom_kws
$deltaBytes = [long]$audio.bytes_received - $baselineBytes
$deltaSegments = [long]$kws.segments_seen - $baselineSegments
$deltaDrops = [long]$kws.vad_max_length_drops - $baselineDrops
Write-Host ""
Write-Host ("[MSDS] SUMMARY: PCM bytes +{0}; speech segments +{1}; max-length noise drops +{2}" -f $deltaBytes, $deltaSegments, $deltaDrops) -ForegroundColor Cyan
if (-not $audio.thread_running -or -not $audio.connected -or $deltaBytes -le 0) {
  Write-Host "[MSDS] NOT HEARING AUDIO: check camera microphone settings, RTSP audio track, audio source and reconnects. Do not change keyword thresholds." -ForegroundColor Yellow
} elseif ($deltaSegments -eq 0) {
  Write-Host "[MSDS] AUDIO ARRIVES BUT NO WORD SEGMENTS: the VAD/filter is suppressing speech, or no speech was present. Compare standard/normal with off/far in supervised tests." -ForegroundColor Yellow
} elseif (-not $kws.last_candidate) {
  Write-Host "[MSDS] SPEECH SEGMENTS EXIST BUT NO CANDIDATE: inspect keyword enrollment and shared KWS model readiness." -ForegroundColor Yellow
} elseif ($kws.last_decision -notin @("accepted", "accepted_help_90")) {
  Write-Host "[MSDS] WORD CANDIDATE WAS REJECTED: check actual class margin, UNKNOWN veto, duration ratio and enrolled template quality. Neural shadow cannot override the decision." -ForegroundColor Yellow
} else {
  Write-Host "[MSDS] A keyword was accepted by the original DTW engine. Check downstream facial verification separately." -ForegroundColor Green
}
Write-Host ("[MSDS] Current settings: noise={0}; publisher-denoise={1}; hearing={2}; VAD={3}; neural={4}" -f `
  $kws.audio_noise_profile, $kws.publisher_audio_denoise_enabled,
  $kws.hearing_profile, $kws.vad_backend, $kws.neural_mode)
Write-Host "[MSDS] Last neural error (if shadow enabled): $($kws.neural_last_error)"
