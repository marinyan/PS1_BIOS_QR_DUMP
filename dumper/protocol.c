#include "protocol.h"

#define PVQR_HEADER_SIZE 24
#define PVQR_PACKET_BITS (PVQR_PACKET_SIZE * 8)
#define PVQR_TIMING_ROW 8
#define PVQR_TIMING_COLUMN 8
#define PVQR_WHITEN_SEED UINT32_C(0xC001D00D)

static void clear_bytes(uint8_t *output, size_t length) {
    size_t index;
    for (index = 0; index < length; index++) {
        output[index] = 0;
    }
}

static void write_u16le(uint8_t *output, uint16_t value) {
    output[0] = (uint8_t)value;
    output[1] = (uint8_t)(value >> 8);
}

static void write_u32le(uint8_t *output, uint32_t value) {
    output[0] = (uint8_t)value;
    output[1] = (uint8_t)(value >> 8);
    output[2] = (uint8_t)(value >> 16);
    output[3] = (uint8_t)(value >> 24);
}

uint32_t pvqr_crc32(const volatile uint8_t *data, size_t length) {
    uint32_t crc = UINT32_C(0xFFFFFFFF);
    size_t index;
    int bit;

    for (index = 0; index < length; index++) {
        crc ^= data[index];
        for (bit = 0; bit < 8; bit++) {
            uint32_t mask = (uint32_t)-(int32_t)(crc & 1u);
            crc = (crc >> 1) ^ (UINT32_C(0xEDB88320) & mask);
        }
    }
    return crc ^ UINT32_C(0xFFFFFFFF);
}

static uint32_t xorshift32(uint32_t state) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
}

static void whiten(uint8_t *data, size_t length) {
    uint32_t state = PVQR_WHITEN_SEED;
    size_t index;
    for (index = 0; index < length; index++) {
        state = xorshift32(state);
        data[index] ^= (uint8_t)state;
    }
}

void pvqr_build_packet(
    uint8_t output[PVQR_PACKET_SIZE],
    const volatile uint8_t *payload,
    uint16_t payload_size,
    uint32_t transfer_id,
    uint16_t chunk_index,
    uint16_t chunk_count,
    uint32_t total_size,
    uint32_t image_crc32
) {
    uint32_t frame_crc;
    uint16_t index;

    clear_bytes(output, PVQR_PACKET_SIZE);
    output[0] = 'P';
    output[1] = 'V';
    output[2] = 'Q';
    output[3] = '1';
    output[4] = 1;
    output[5] = 0;
    write_u32le(output + 6, transfer_id);
    write_u16le(output + 10, chunk_index);
    write_u16le(output + 12, chunk_count);
    write_u32le(output + 14, total_size);
    write_u32le(output + 18, image_crc32);
    write_u16le(output + 22, payload_size);
    for (index = 0; index < payload_size; index++) {
        output[PVQR_HEADER_SIZE + index] = payload[index];
    }

    frame_crc = pvqr_crc32(output, PVQR_PACKET_SIZE - 4);
    write_u32le(output + PVQR_PACKET_SIZE - 4, frame_crc);
    whiten(output, PVQR_PACKET_SIZE);
}

static int in_finder(int x, int y) {
    static const int origins[3][2] = {
        {2, 2},
        {PVQR_GRID_WIDTH - 7, 2},
        {2, PVQR_GRID_HEIGHT - 7}
    };
    int index;
    for (index = 0; index < 3; index++) {
        int dx = x - origins[index][0];
        int dy = y - origins[index][1];
        if (dx >= 0 && dx < 5 && dy >= 0 && dy < 5) {
            return 1;
        }
    }
    return 0;
}

static int is_reserved(int x, int y) {
    return x == 0 || y == 0 || x == PVQR_GRID_WIDTH - 1 || y == PVQR_GRID_HEIGHT - 1
        || in_finder(x, y) || y == PVQR_TIMING_ROW || x == PVQR_TIMING_COLUMN;
}

static void draw_finder(uint8_t matrix[PVQR_GRID_HEIGHT][PVQR_GRID_WIDTH], int x0, int y0) {
    int x;
    int y;
    for (y = 0; y < 5; y++) {
        for (x = 0; x < 5; x++) {
            int edge = x == 0 || x == 4 || y == 0 || y == 4;
            int center = x == 2 && y == 2;
            matrix[y0 + y][x0 + x] = (uint8_t)(edge || center ? 0 : 7);
        }
    }
}

void pvqr_packet_to_matrix(
    uint8_t matrix[PVQR_GRID_HEIGHT][PVQR_GRID_WIDTH],
    const uint8_t packet[PVQR_PACKET_SIZE]
) {
    int x;
    int y;
    int bit_index = 0;

    clear_bytes(&matrix[0][0], PVQR_GRID_WIDTH * PVQR_GRID_HEIGHT);
    draw_finder(matrix, 2, 2);
    draw_finder(matrix, PVQR_GRID_WIDTH - 7, 2);
    draw_finder(matrix, 2, PVQR_GRID_HEIGHT - 7);

    for (x = 1; x < PVQR_GRID_WIDTH - 1; x++) {
        matrix[PVQR_TIMING_ROW][x] = (uint8_t)(x & 7);
    }
    for (y = 1; y < PVQR_GRID_HEIGHT - 1; y++) {
        matrix[y][PVQR_TIMING_COLUMN] = (uint8_t)(y & 7);
    }

    for (y = 0; y < PVQR_GRID_HEIGHT; y++) {
        for (x = 0; x < PVQR_GRID_WIDTH; x++) {
            int component;
            uint8_t value = 0;
            if (is_reserved(x, y)) {
                continue;
            }
            for (component = 0; component < 3; component++) {
                uint8_t bit;
                value <<= 1;
                if (bit_index < PVQR_PACKET_BITS) {
                    bit = (uint8_t)((packet[bit_index >> 3] >> (7 - (bit_index & 7))) & 1);
                } else {
                    bit = (uint8_t)((bit_index - PVQR_PACKET_BITS) & 1);
                }
                value |= bit;
                bit_index++;
            }
            matrix[y][x] = value;
        }
    }
}
