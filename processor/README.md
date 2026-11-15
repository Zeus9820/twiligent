# Mac clipping processor

Studio queues video jobs and calls Cloudflare Workers AI (`@cf/zai-org/glm-4.7-flash`).
This outbound-only agent runs PeakCut transcription and FFmpeg rendering on the Mac.
It does not expose a local web port or require a tunnel/domain. Nothing is published automatically.

## Setup

Install FFmpeg and uv, then run `processor/setup.sh` from the repository. This creates an
isolated Python 3.12 environment and downloads the Parakeet speech model. Run
`processor/start.sh`; open Studio → Publishing → Clipping and confirm the displayed
10-character pairing code. It expires after ten minutes. After pairing, credentials are
kept in `~/Library/Application Support/Kratos Studio/PeakCut/config.json`, with mode 0600.
No Cloudflare account key or social publishing token is copied to the processor.

A user LaunchAgent can keep the agent running at login; `processor/install-service.py`
installs it and `processor/uninstall-service.py` stops and removes it. Keep the Mac awake
while processing. Pending jobs wait when the Mac is offline. The idle processor checks for work about once a minute to keep request usage low. The login service runs an installed copy under Application Support; rerun install-service.py after processor code updates.

## Operation

- Hosted processor sources: uploaded MP4/MOV (up to 2 GB) or a supported public video URL; up to two hours.
- Local desktop app sources: uploaded MP4/MOV (up to 2 GB) or a supported public video URL; up to four hours.
- One source is processed at a time per Mac, with one speech-model copy and one renderer.
- Each job runs in a child process. Studio receives stage/progress heartbeats.
- Job claims are leased and fenced; a stale processor cannot overwrite a cancelled/retried job.
- Downloaded sources, transcripts and clips stay under the local application-support directory.
- Finished MP4s upload to the existing R2 bucket in 8 MB parts, then appear in Studio.
- Studio offers preview, download and a handoff to the existing Publish form for manual review.
- GLM receives text transcripts, not raw video frames. Sparse-dialogue gameplay can yield poor
  or no candidates. The bundled Parakeet v2 model is primarily for English speech; do not
  assume accurate Hindi/Hinglish recognition. AI fallback is shown as a warning.
- Cloudflare AI and R2 share existing quotas. Installing this does not change the billing plan.
- Cancel a running job in Studio. Retry is explicit; jobs are not automatically published or retried.

PeakCut is MIT licensed and pinned in `third_party/peakcut/UPSTREAM.md`.

On this Mac, the processor uses WhisperKit's multilingual small model with word timestamps
when the installed `bin/whisperkit-cli` is available, falling back to Parakeet on errors.
Existing YouTube captions may still be used for selection when available. Rendering prefers
VideoToolbox and falls back to software. WhisperKit models are stored under the PeakCut
application-support directory. Restart the local studio service after updating its adapter;
the web processor loads updates when it starts its next job.

## Validation notes

The untouched upstream suite has two baseline failures on
this Mac/vendor arrangement: Linux CPU-load simulation and version checks requiring an upstream
Git checkout. The adapter does not use upstream auto-updates or its CPU queue. Queue, pairing,
lease fencing, AI bridge and a speech-to-render pipeline are checked independently.


## Local desktop app

Run `processor/install-local.py` with the processor virtual environment to install
**Kratos Studio Local.app** in `~/Applications` and a Desktop shortcut. It opens a native
Mac window backed by a loopback-only service at `http://127.0.0.1:8765/app`.
The service starts at login. It reuses the existing Mac pairing for Flash; there is no
website login. Uploads, transcripts, jobs and completed clips remain on this Mac under
`~/Library/Application Support/Kratos Studio/PeakCut/local-studio`.
Only the transcript/prompt is sent to Cloudflare for AI analysis. Internet is still
needed for Flash and remote video downloads. Local and hosted clipping share the
same daily Flash quota. Local jobs do not automatically sync to the hosted job list.

With Xcode Command Line Tools installed, the installer compiles the small Cocoa/WebKit
launcher in `LocalApp.swift`. Otherwise it installs a shortcut opening the same local
interface in the default browser. Local mode retains PeakCut's own clip editor/export
interface and uses a separate job library from the hosted Studio. It never auto-posts.
