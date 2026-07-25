# On-device Whisper for dictation

Status: accepted (2026-07-23)

Dictation is transcribed by a local `whisper.cpp` server (multilingual model `small`,
language auto-detect) instead of the browser's Web Speech API the composer used before.
The deciding requirement is mixed German/English speech in one utterance: the Web
Speech API locks a single `lang` per session and mangles code-switched sentences, while
Whisper handles them natively — and it keeps audio on the machine, matching Syflo's
local-first setup (Ollama, SearXNG).

The whisper server is not a permanent resident: the backend spawns it lazily on the
first dictation and kills it after an idle timeout (~10 min). On a 24 GB unified-memory
Mac already under pressure from Ollama vision models, a permanently resident ~500 MB
STT model would buy nothing except a higher swap risk for token generation; the price
of lazy spawning is a cold start on the first dictation after a pause (measured
2026-07-23: ~8 s when the model file is not in the OS page cache, ~0.6 s when it is;
a warm transcription takes ~0.3 s).

The audio path avoids transcoding entirely: an AudioWorklet taps the getUserMedia
stream the composer already opens for the volume waveform, collects 16 kHz mono PCM,
and the frontend posts it as a WAV to the backend, which relays it to the whisper
server. This removes the second microphone consumer (Web Speech API and the analyser
used to compete for the mic) and keeps ffmpeg out of the stack — rejected:
MediaRecorder (webm/opus) + ffmpeg conversion in the backend.

Holding the spacebar is push-to-talk everywhere (2026-07-23): outside text inputs a
global keydown/keyup pair in `useVoiceInput` starts/stops the recording; inside the
composer textarea, ChatArea distinguishes tap from hold (`SPACE_HOLD_MS` = 300 ms) —
a quick tap types a normal space, holding past the threshold removes that one space
again and starts dictation (key repeats are swallowed so holding never types a space
burst). Enter sends without the composer focused too, via a window listener that
yields to focused interactive elements (buttons, links, other inputs) so their native
Enter behaviour wins; Enter pressed while Whisper is still transcribing queues the
send and fires it the moment the transcript lands in the input.

Rejected: Web Speech API + language toggle (no code-switching, audio leaves the
machine); Node whisper bindings in the backend (native addon makes `npm install`
fragile); a Python `faster-whisper` microservice (a whole new stack for one feature);
Whisper model sizes other than `small` (`base` too error-prone for German, `medium`
too heavy for the RAM budget).
