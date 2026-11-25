# Battle Tanks

A 3D browser game. Hide your five tank units on a 10 x 10 field, then take turns
with your opponent firing at each other's field. The first to destroy every enemy
unit wins.

**Play it: https://raffepaffe.github.io/battletanks/**

- **Against the computer**, at three levels: Recruit, Veteran, General.
- **Against a friend on a second device.** The two devices talk to each other
  with short chirps from speaker to microphone. There is no server and no
  account; the devices only need to be close to each other.

## The units

Real tanks from the first half of the 20th century. A unit is a column of
identical tanks, one per cell.

| Unit | Tanks | From |
| --- | --- | --- |
| T-34 column | 5 | Soviet Union, 1940 |
| M4 Sherman company | 4 | United States, 1942 |
| Churchill troop | 3 | United Kingdom, 1941 |
| Tiger I platoon | 3 | Germany, 1942 |
| Renault FT section | 2 | France, 1917 |

## Rules

- Units stand in straight lines, across or down. Rocks and lakes are the same on
  both fields; nothing can stand there and they cannot be fired at.
- On your turn, fire one shell at a cell of the enemy field. You are told whether
  it hit a tank, and when a whole unit is destroyed.
- Once per battle you may call an **air strike** (three cells in a row) and send
  a **scout drone** (reports how many intact tanks stand in a 3 x 3 area).

## Playing on two devices

1. Open the game on both devices and choose "Two devices, linked by sound".
2. Turn the volume up. On a phone, switch silent mode off.
3. Put the devices close together. Two phones work best top to top, a few
   centimetres apart.
4. Allow the microphone on both, then tap **Call** on one of them.

If they do not find each other, open the **Radio check** page from the menu on
both devices. It shows whether each device hears the other's test chirps.

After the battle each device reveals its field and checks that the other one
reported honestly. This catches mistakes and casual cheating; it is not strong
cryptography.

## How the sound link works

Each chirp is a short burst of tones between 1.5 and 5.3 kHz: a sync tone, then
one of 17 tones per four bits, 60 ms each, with a checksum at the end. A move is
under a second of sound, and it is repeated until the other device confirms it. Each device sends in its own band of tones. The code is in
`src/link/`.

The idea of linking two browsers with sound comes from Simon Willison's
[Chirp Pong](https://simonwillison.net/2026/Oct/15/chirp-pong/) and
[Battle Drones](https://simonwillison.net/2026/Oct/20/battledrones/). The modem
and protocol here are written from scratch for a turn-based game.

## Development

No build step. The only tool needed is Node (for the tests).

```sh
npm test          # run the tests
npm run serve     # then open http://localhost:8080
```

See [AGENTS.md](AGENTS.md) for the layout of the code and the working rules
(red/green TDD, self-review after every change).

## Third-party code

[three.js](https://threejs.org/) r187 in `vendor/three/`, unmodified, MIT
licensed by its authors (see `vendor/three/LICENSE`).
