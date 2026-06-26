# Streaming videos

Drop your real video files here. The mock streaming player loads them from
`/videos/<filename>` (Next.js serves everything in `public/` at the site root).

The catalog in `apps/web-client/src/components/MockVideoPlayer.tsx` maps each
title to a `src`. By default it expects these filenames (rename your files to
match, or edit the `src` values in the catalog):

| Content ID | Expected file              | Title                      |
| ---------- | -------------------------- | -------------------------- |
| movie-001  | `interledger-heist.mp4`    | The Interledger Heist      |
| movie-002  | `open-payments-rising.mp4` | Open Payments Rising       |
| show-001   | `breaking-gnap-s1e1.mp4`   | Breaking GNAP (S1E1)       |
| show-002   | `breaking-gnap-s1e2.mp4`   | Breaking GNAP (S1E2)       |
| live-001   | `live-pitch.mp4`           | Live: Hackathon Final Pitch|

Any browser-playable container works (`.mp4` with H.264/AAC is the safest).
For large files consider Git LFS or keeping them out of version control.
