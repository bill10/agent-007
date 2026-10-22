#!/bin/sh
# The two test lines for docs/voice-calls-plan.md, as 16 kHz mono PCM in
# the folder given (default: the current one). Needs macOS say and ffmpeg.
#   latency.pcm  one 2.5 s question; speech ends at its end
#   pause.pcm    a sentence, 1.5 s of silence, its second half (pause 2.31-3.84 s, speech ends ~6.55 s)
set -e
out=${1:-.}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
voice=${OWNER_VOICE:-Ava (Premium)}
say -v "$voice" -o "$tmp/a.aiff" "I want you to look at the landing page copy"
say -v "$voice" -o "$tmp/b.aiff" "and also check the pricing section before lunch."
say -v "$voice" -o "$tmp/s.aiff" "What's the status of the dark mode pull request?"
for f in a b s; do ffmpeg -loglevel error -y -i "$tmp/$f.aiff" -ar 16000 -ac 1 -f s16le "$tmp/$f.pcm"; done
cp "$tmp/s.pcm" "$out/latency.pcm"
head -c 48000 /dev/zero | cat "$tmp/a.pcm" - "$tmp/b.pcm" > "$out/pause.pcm"
