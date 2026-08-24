#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../protocol.h"

static const uint8_t expected_prefix[16] = {
    0xFD, 0xD1, 0x00, 0x19, 0xDB, 0x18, 0xFA, 0x36,
    0xEE, 0xF3, 0x0C, 0xA5, 0xCC, 0x1A, 0xCA, 0xBD
};

static const uint8_t expected_suffix[16] = {
    0x70, 0xA3, 0xE4, 0x53, 0x93, 0x8A, 0x9E, 0xB4,
    0x47, 0x94, 0x32, 0x4B, 0xB4, 0xA3, 0xF5, 0x81
};

int main(void) {
    uint8_t payload[PVQR_PAYLOAD_SIZE];
    uint8_t packet[PVQR_PACKET_SIZE];
    uint8_t matrix[PVQR_GRID_HEIGHT][PVQR_GRID_WIDTH];
    uint32_t matrix_hash = UINT32_C(2166136261);
    int x;
    int y;

    for (x = 0; x < PVQR_PAYLOAD_SIZE; x++) {
        payload[x] = (uint8_t)(x * 17 + 3);
    }
    pvqr_build_packet(
        packet,
        payload,
        PVQR_PAYLOAD_SIZE,
        UINT32_C(0x12345678),
        7,
        42,
        UINT32_C(524288),
        UINT32_C(0x89ABCDEF)
    );

    if (pvqr_crc32(packet, sizeof(packet)) != UINT32_C(0x23923D8E)
        || memcmp(packet, expected_prefix, sizeof(expected_prefix)) != 0
        || memcmp(packet + sizeof(packet) - sizeof(expected_suffix), expected_suffix, sizeof(expected_suffix)) != 0) {
        fputs("packet vector mismatch\n", stderr);
        return 1;
    }

    pvqr_packet_to_matrix(matrix, packet);
    for (y = 0; y < PVQR_GRID_HEIGHT; y++) {
        for (x = 0; x < PVQR_GRID_WIDTH; x++) {
            matrix_hash ^= matrix[y][x];
            matrix_hash *= UINT32_C(16777619);
        }
    }
    if (matrix_hash != UINT32_C(0xC9A35175)) {
        fputs("matrix vector mismatch\n", stderr);
        return 1;
    }

    puts("ok: C and JavaScript protocol vectors agree");
    return 0;
}
