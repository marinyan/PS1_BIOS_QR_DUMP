#!/usr/bin/env python3
"""Convert one little-endian ELF32 load image into a PS-X EXE."""

from __future__ import annotations

from pathlib import Path
import struct
import sys

ELF_HEADER_SIZE = 52
PROGRAM_HEADER = struct.Struct("<IIIIIIII")
PSX_HEADER_SIZE = 0x800
SECTOR_SIZE = 0x800
STACK_ADDRESS = 0x801FFF00


def align(value: int, alignment: int) -> int:
    return (value + alignment - 1) & ~(alignment - 1)


def convert(source: Path, destination: Path) -> None:
    elf = source.read_bytes()
    if len(elf) < ELF_HEADER_SIZE or elf[:6] != b"\x7fELF\x01\x01":
        raise ValueError("input is not a little-endian ELF32 file")

    entry = struct.unpack_from("<I", elf, 24)[0]
    program_offset = struct.unpack_from("<I", elf, 28)[0]
    program_size = struct.unpack_from("<H", elf, 42)[0]
    program_count = struct.unpack_from("<H", elf, 44)[0]
    if program_size < PROGRAM_HEADER.size:
        raise ValueError("unsupported ELF program header")

    segments: list[tuple[int, bytes, int]] = []
    for index in range(program_count):
        offset = program_offset + index * program_size
        if offset + PROGRAM_HEADER.size > len(elf):
            raise ValueError("ELF program header is truncated")
        fields = PROGRAM_HEADER.unpack_from(elf, offset)
        kind, file_offset, virtual_address, _, file_size, memory_size, _, _ = fields
        if kind == 1 and file_size:
            if memory_size < file_size or file_offset + file_size > len(elf):
                raise ValueError("ELF load segment is invalid or truncated")
            segments.append((virtual_address, elf[file_offset : file_offset + file_size], memory_size))
    if not segments:
        raise ValueError("ELF contains no loadable data")

    load_address = min(address for address, _, _ in segments)
    file_end = max(address + len(data) for address, data, _ in segments)
    memory_end = max(address + memory_size for address, _, memory_size in segments)
    if load_address < 0x80010000 or memory_end > STACK_ADDRESS:
        raise ValueError("ELF load image is outside PS1 user RAM")

    image_size = align(file_end - load_address, SECTOR_SIZE)
    image = bytearray(image_size)
    for address, data, _ in segments:
        start = address - load_address
        image[start : start + len(data)] = data

    header = bytearray(PSX_HEADER_SIZE)
    header[:8] = b"PS-X EXE"
    struct.pack_into("<I", header, 0x10, entry)
    struct.pack_into("<I", header, 0x14, 0)
    struct.pack_into("<I", header, 0x18, load_address)
    struct.pack_into("<I", header, 0x1C, image_size)
    struct.pack_into("<I", header, 0x30, STACK_ADDRESS)
    header[0x4C : 0x4C + 27] = b"PS1 BIOS VIDEO DUMPER / MIT"
    destination.write_bytes(header + image)


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {Path(sys.argv[0]).name} input.elf output.exe", file=sys.stderr)
        return 2
    try:
        convert(Path(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, ValueError, struct.error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
