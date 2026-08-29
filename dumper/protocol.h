#ifndef PS1BIOSQR_PROTOCOL_H
#define PS1BIOSQR_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define PVQR_GRID_WIDTH 40
#define PVQR_GRID_HEIGHT 30
#define PVQR_MODULE_SIZE 8
#define PVQR_PACKET_SIZE 346
#define PVQR_PAYLOAD_SIZE 318
#define PVQR_FLAG_LZSS 0x01u
#define PVQR_LZSS_WINDOW_SIZE 4096

uint32_t pvqr_crc32(const volatile uint8_t *data, size_t length);

size_t pvqr_lzss_encode(
    uint8_t *output,
    size_t output_capacity,
    const volatile uint8_t *input,
    size_t input_size,
    int32_t positions[PVQR_LZSS_WINDOW_SIZE]
);

void pvqr_build_packet(
    uint8_t output[PVQR_PACKET_SIZE],
    const volatile uint8_t *payload,
    uint16_t payload_size,
    uint32_t transfer_id,
    uint16_t chunk_index,
    uint16_t chunk_count,
    uint32_t total_size,
    uint32_t image_crc32,
    uint8_t flags
);

void pvqr_packet_to_matrix(
    uint8_t matrix[PVQR_GRID_HEIGHT][PVQR_GRID_WIDTH],
    const uint8_t packet[PVQR_PACKET_SIZE]
);

#endif
