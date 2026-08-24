from __future__ import annotations

import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "tools" / "elf2psx.py"
SPEC = importlib.util.spec_from_file_location("elf2psx", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
elf2psx = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(elf2psx)


class ElfToPsxTests(unittest.TestCase):
    def test_minimal_load_segment(self):
        header = bytearray(52)
        header[:6] = b"\x7fELF\x01\x01"
        struct.pack_into("<I", header, 24, 0x80010000)
        struct.pack_into("<I", header, 28, 52)
        struct.pack_into("<H", header, 42, 32)
        struct.pack_into("<H", header, 44, 1)
        program = struct.pack(
            "<IIIIIIII",
            1,
            84,
            0x80010000,
            0x80010000,
            4,
            4,
            5,
            4,
        )

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.elf"
            destination = Path(directory) / "output.exe"
            source.write_bytes(header + program + b"\x01\x02\x03\x04")
            elf2psx.convert(source, destination)
            output = destination.read_bytes()

        self.assertEqual(output[:8], b"PS-X EXE")
        self.assertEqual(struct.unpack_from("<I", output, 0x10)[0], 0x80010000)
        self.assertEqual(struct.unpack_from("<I", output, 0x18)[0], 0x80010000)
        self.assertEqual(struct.unpack_from("<I", output, 0x1C)[0], 0x800)
        self.assertEqual(struct.unpack_from("<I", output, 0x28)[0], 0)
        self.assertEqual(struct.unpack_from("<I", output, 0x30)[0], elf2psx.STACK_ADDRESS)
        self.assertEqual(output[0x800:0x804], b"\x01\x02\x03\x04")
        self.assertEqual(len(output), 0x1000)


if __name__ == "__main__":
    unittest.main()
