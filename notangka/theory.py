"""Music theory helpers: pitch names, keys, chords, scale degrees (movable do)."""
from __future__ import annotations

SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
# Major keys (by do pitch-class) conventionally spelled with flats
FLAT_DO = {1, 3, 5, 8, 10}  # Db Eb F Ab Bb
KEY_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

# Chord qualities: suffix -> (intervals, template weights)
QUALITIES = {
    "": ([0, 4, 7], [1.0, 0.85, 0.85]),
    "m": ([0, 3, 7], [1.0, 0.85, 0.85]),
    "7": ([0, 4, 7, 10], [1.0, 0.8, 0.8, 0.65]),
    "maj7": ([0, 4, 7, 11], [1.0, 0.8, 0.8, 0.65]),
    "m7": ([0, 3, 7, 10], [1.0, 0.8, 0.8, 0.65]),
}
SIMPLE_QUALS = ["", "m"]
EXTENDED_QUALS = ["", "m", "7", "maj7", "m7"]

# Semitone above do -> not angka symbol (movable do)
DEGREE = {0: "1", 1: "#1", 2: "2", 3: "#2", 4: "3", 5: "4", 6: "#4",
          7: "5", 8: "#5", 9: "6", 10: "b7", 11: "7"}


def pc_name(pc: int, do_pc: int | None = None) -> str:
    """Spell a pitch class, using flats when the key (do) prefers flats."""
    pc %= 12
    if do_pc is not None and (do_pc % 12) in FLAT_DO:
        return FLAT[pc]
    return SHARP[pc]


def chord_name(root: int, qual: str, do_pc: int | None = None) -> str:
    return pc_name(root, do_pc) + qual


def key_label(tonic_pc: int, mode: str) -> str:
    """'E' for E major, 'C#m' for C# minor (spelled relative to its do)."""
    if mode == "minor":
        do = (tonic_pc + 3) % 12
        return pc_name(tonic_pc, do) + "m"
    return KEY_NAMES[tonic_pc % 12]


def do_of(tonic_pc: int, mode: str) -> int:
    """Not angka convention in Indonesia: minor songs use the relative major as do."""
    return (tonic_pc + 3) % 12 if mode == "minor" else tonic_pc % 12


def degree_symbol(midi: int, do_pc: int, base_midi: int) -> tuple[str, int]:
    """Return (symbol like '#4', octave offset) for a MIDI pitch.

    base_midi is the MIDI number of the 'unmarked' do (no octave dot)."""
    rel = midi - base_midi
    octave, semis = divmod(rel, 12)
    return DEGREE[semis], octave


def diatonic_chords(do_pc: int) -> set[tuple[int, str]]:
    """Diatonic triads + V7 of the major key whose tonic is do_pc."""
    d = do_pc
    return {
        (d % 12, ""), ((d + 2) % 12, "m"), ((d + 4) % 12, "m"), ((d + 5) % 12, ""),
        ((d + 7) % 12, ""), ((d + 9) % 12, "m"), ((d + 7) % 12, "7"),
        ((d + 2) % 12, "m7"), ((d + 9) % 12, "m7"), (d % 12, "maj7"), ((d + 5) % 12, "maj7"),
    }
