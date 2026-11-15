# PeakCut integration into Kratos Studio

Reviewed upstream: https://github.com/haziqahmedqasmi/PeakCut at `44b7c6236b11dc5458148e0905afc3e1a623aeb5` (2026-11-15). MIT license permits adaptation with its copyright/license notice retained.

## Proposed flow

1. Studio's authenticated Clipping page creates a job from an uploaded video or a supported public source URL.
2. A separate PeakCut Python process downloads/probes the video, transcribes speech and measures audio activity.
3. PeakCut's custom OpenAI-compatible provider calls a narrow authenticated Studio AI bridge. The bridge uses the existing Cloudflare Workers AI binding and fixes the model to `@cf/zai-org/glm-4.7-flash`.
4. The model returns candidate start/end timestamps and metadata. Validate ranges, durations, overlap and structured output before rendering. Set `enable_thinking: false`, an explicit output budget and reject truncated JSON. Upstream's generic provider does not currently set those GLM-specific parameters, so passing through the defaults is insufficient.
5. PeakCut renders the selected clips with FFmpeg. Studio shows stage/progress, previews and downloads, and sends only user-selected outputs into Studio's existing publishing flow.

## Runtime choice

The owner selected the Mac on 2026-11-15. PeakCut runs locally while the Mac is awake. The current Cloudflare Worker is the control and AI layer; it does not host PeakCut's FFmpeg subprocesses or local speech model. A local service also requires a deliberately authenticated integration with the hosted Studio; an iframe or a public unauthenticated tunnel is not a complete integration.

The isolated Python 3.12 runtime and Parakeet speech model are installed. The outbound processor is a user LaunchAgent. Studio has a deployed Publishing → Clipping page, a scoped device-pairing flow, leased Redis job queue, fixed-model AI bridge and multipart R2 result upload. A synthetic-video test verified real GLM inference, speech transcription, 1080×1920 rendering, result upload and completion; test cloud artifacts were removed. Account pairing remains a user-confirmed step. See processor/README.md for operation and known limitations.

## Quality considerations

PeakCut's scout reads timestamped transcripts plus loudness/chat signals. GLM Flash is a text model; it is not inspecting video frames through this pipeline. Silent gameplay needs visual/audio candidate signals to avoid selecting arbitrary loud moments. The initial integration should expose that limitation and retain manual range review. Validate the speech model against the actual spoken languages before promising Hindi/Hinglish transcription quality.

## Integration boundaries

- Reuse Studio login and account ownership checks; isolate every job/artifact by authenticated user.
- Keep Cloudflare credentials on the server, limit AI-bridge input/output and enforce rate limits.
- Keep PeakCut's direct auto-posting disabled for Studio-managed publishing.
- Store job status durably and poll one job/page at a time. Make job creation idempotent and cancellation explicit.
- Stream or upload large media directly to the processing service/storage; do not proxy whole video bodies through Workers.
- Preserve upstream MIT notices and pin a tested upstream revision.
- Test the upstream app before and after modifications, as its AGENTS.md requires; also verify one small end-to-end clip with a real source video.

Sources: upstream README, LICENSE, AGENTS.md, studio/ai.py, studio/brain.py, studio/server.py and studio/render.py; https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/ .
