# AGENTS.md

Guidance for anyone working on Battle Tanks.

## What this is

A 3D browser game: each player hides five tank units on a 10 x 10 field and the
players take turns firing at each other's field. Play against the computer, or
against a friend on a second device. Two devices talk to each other only with
short chirps from speaker to microphone; there is no server.

The site is static files served by GitHub Pages from the repository root.
There is no build step and there are no runtime or development dependencies
other than Node (for tests) and the copy of three.js in `vendor/three/`.

## Commands

```sh
npm test          # node --test, runs everything in test/
npm run serve     # python3 -m http.server 8080, then open http://localhost:8080
```

Useful URLs while developing:

- `index.html?link=tabs` in two tabs of one browser: the two-device game with a
  BroadcastChannel standing in for sound.
- `index.html?speed=8`: animations and the computer's thinking run faster.
- `radio.html`: radio check, including a silent self-test of the Web Audio
  pipeline that needs no microphone.

## Working rules

### 1. Red/green TDD, always

For every change to behaviour in `src/core`, `src/computer`, `src/game` or `src/link`:

1. Write or change a test in `test/` first.
2. Run `npm test` and see it fail for the right reason (red).
3. Write the smallest change that makes it pass (green).
4. Tidy up with the tests still green.

Do not write logic first and tests afterwards, and do not weaken a test to make
it pass. A bug fix starts with a test that reproduces the bug.

Code in `src/ui` and `src/link/audio-transport.js` needs a browser and is not
covered by `npm test`. Keep it thin: anything that can be decided without a
screen or a speaker belongs in a tested module. Verify UI changes by running the
game in a browser (see "Useful URLs") and say in your report what you checked.

### 2. Self-review after every turn

After each turn in which you created or changed anything, before reporting back:

1. Re-read your whole diff as a reviewer who did not write it.
2. Follow each changed value through every layer it passes, including code you
   did not touch. Example: a new field on an action goes
   UI -> GameController -> Duel/Tracker -> Session -> messages -> frame ->
   modem and back up the same way on the other device.
3. Look for: broken rules, unhandled errors, stale state after leaving a game,
   anything two devices could disagree on, dead code, misleading names or
   comments, missing tests.
4. Fix what you find (red/green for logic), run `npm test` again, then report.
   Mention what the review found.

### 3. Every layer enforces its own rules

Do not rely on another layer to keep bad input out.

- `Board` (the defender) validates every incoming action, whoever sent it.
- `Tracker` (the attacker) validates its own actions before they are sent and
  checks every reported result against what it already knows.
- `messages.js` rejects malformed payloads; `frame.js` rejects bad checksums.
- `Session` ignores frames for the wrong turn, band or key.

Data from the other device is untrusted. Never make a check weaker because "the
UI would not send that".

### 4. Keep the two devices in step

Anything both devices must agree on has to be derived from data they share, with
integer maths only: terrain comes from the pairing nonce through
`src/core/rng.js`. Do not use `Math.random`, floating point or the clock for
shared state.

The numbers in `src/core/fleet.js` (unit ids), `src/core/board.js` (action kinds,
outcomes) and `src/link/messages.js`, the frame format and the tone plan in
`src/link/modem.js` are the wire protocol. If you change any of them in an
incompatible way, bump `PROTO` in `src/link/session.js` so that devices running
different versions refuse to pair instead of misunderstanding each other.

### 5. Sound link constraints

- Message payloads are at most 15 bytes. A move must stay under one second of
  sound.
- Sound effects must stay below the modem tones (1500 Hz and up). During a link
  game `Sfx.setLinkSafe(true)` closes the effects filter to 700 Hz; new effects
  must go through `Sfx` and its filter.
- The microphone needs a secure page (https or localhost) and a user gesture.
- Real speaker-to-microphone behaviour cannot be verified by the tests. When
  you change `modem.js` or `audio-transport.js`, run the modem tests,
  run the silent self-test on `radio.html`, and state clearly that two real
  devices still need to be tried by a person.

### 6. Originality and content

- This is an original game. Do not copy code, art, names or level designs from
  other games.
- Tank names are real tanks from the first half of the 20th century. Keep any
  new unit historically real and from that period, and keep its facts
  (nation, year) correct.
- No external assets: models are built from primitives in `src/ui/models.js`,
  sounds are synthesised in `src/ui/sfx.js`.

### 7. Style

- Plain ES modules, no framework, no bundler, no TypeScript.
- Small files with one job; comments explain why, not what.
- User-facing text is plain English, no jargon. Never show a raw error object.
- No `alert`, `confirm` or `prompt`.

## Layout

```
index.html, radio.html, css/     the two pages
src/core/      rules: grid, fleet, terrain, Board (defender), Tracker (attacker),
               Duel (turns), commitment (fair-play check). Pure, tested.
src/computer/  the computer's choice of action. Pure, tested.
src/game/      GameController and the two kinds of opponent (computer, linked device).
               Tested, no DOM.
src/link/      crc, frame, messages, modem (pure, tested); session (protocol,
               tested with a fake clock); audio-transport (browser only).
src/ui/        three.js scene, models, sound effects, app flow, radio check.
vendor/three/  three.js r187, unmodified (MIT).
test/          node:test suites; test/helpers/fake-link.js simulates the room.
```

How a move travels in a two-device game:

```
tap -> App.fire -> GameController.fire -> Duel.beginAction (Tracker checks it)
    -> LinkOpponent.resolve -> Session.sendAction -> messages -> frame -> modem
    -> speaker ... microphone -> modem -> frame (checksum, session key)
    -> Session -> GameController._incoming -> Duel.receiveAction -> Board.resolve
    -> result travels back the same way -> Tracker.apply checks it -> animation
```

After the battle both devices reveal layout and salt; `auditReveal` checks them
against the fingerprint sent before the battle and replays every report.

## Git and publishing

- Repository: `raffepaffe/battletanks` on GitHub, public, GitHub Pages from
  `main` at `/`. Published at https://raffepaffe.github.io/battletanks/
- Pushing to `main` publishes the game. Run `npm test` first.
- Commit or push only when asked to.
