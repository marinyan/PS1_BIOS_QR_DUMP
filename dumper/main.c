#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

#define SCREEN_WIDTH (PVQR_GRID_WIDTH * PVQR_MODULE_SIZE)
#define SCREEN_HEIGHT (PVQR_GRID_HEIGHT * PVQR_MODULE_SIZE)
#define BIOS_ADDRESS UINT32_C(0xBFC00000)
#define BIOS_SIZE UINT32_C(0x00080000)
#define HOLD_VSYNCS 1
#define TRANSFER_XOR UINT32_C(0x50565152)

#define GPU_GP0 (*(volatile uint32_t *)UINT32_C(0xBF801810))
#define GPU_STAT (*(volatile uint32_t *)UINT32_C(0xBF801814))
#define GPU_GP1 (*(volatile uint32_t *)UINT32_C(0xBF801814))
#define IRQ_STATUS (*(volatile uint32_t *)UINT32_C(0xBF801070))

#define GPU_READY_COMMAND (UINT32_C(1) << 26)
#define IRQ_VBLANK UINT32_C(1)

static const uint16_t palette[8] = {
    0x0000u,
    0x7C00u,
    0x03E0u,
    0x7FE0u,
    0x001Fu,
    0x7C1Fu,
    0x03FFu,
    0x7FFFu
};

static uint16_t frame_buffer[SCREEN_WIDTH * SCREEN_HEIGHT];
static uint8_t matrix[PVQR_GRID_HEIGHT][PVQR_GRID_WIDTH];
static uint8_t packet[PVQR_PACKET_SIZE];

static void gpu_gp1(uint32_t value) {
    GPU_GP1 = value;
}

static void gpu_gp0(uint32_t value) {
    while ((GPU_STAT & GPU_READY_COMMAND) == 0) {
    }
    GPU_GP0 = value;
}

static void gpu_initialize(void) {
    gpu_gp1(UINT32_C(0x00000000));
    gpu_gp1(UINT32_C(0x03000001));
    gpu_gp1(UINT32_C(0x04000000));
    gpu_gp1(UINT32_C(0x05000000));
    gpu_gp1(UINT32_C(0x06C60260));
    gpu_gp1(UINT32_C(0x07040010));
    gpu_gp1(UINT32_C(0x08000001));
    gpu_gp1(UINT32_C(0x03000000));
}

static void wait_vblank(void) {
    IRQ_STATUS = ~IRQ_VBLANK;
    while ((IRQ_STATUS & IRQ_VBLANK) == 0) {
    }
    IRQ_STATUS = ~IRQ_VBLANK;
}

static void gpu_upload_frame(int page) {
    uint32_t y = page ? SCREEN_HEIGHT : 0;
    size_t index;

    gpu_gp0(UINT32_C(0xA0000000));
    gpu_gp0(y << 16);
    gpu_gp0(((uint32_t)SCREEN_HEIGHT << 16) | SCREEN_WIDTH);
    for (index = 0; index < SCREEN_WIDTH * SCREEN_HEIGHT; index += 2) {
        uint32_t pair = frame_buffer[index] | ((uint32_t)frame_buffer[index + 1] << 16);
        gpu_gp0(pair);
    }
}

static void render_matrix(void) {
    int module_x;
    int module_y;
    int pixel_x;
    int pixel_y;

    for (module_y = 0; module_y < PVQR_GRID_HEIGHT; module_y++) {
        for (module_x = 0; module_x < PVQR_GRID_WIDTH; module_x++) {
            uint16_t color = palette[matrix[module_y][module_x] & 7];
            for (pixel_y = 0; pixel_y < PVQR_MODULE_SIZE; pixel_y++) {
                uint16_t *row = frame_buffer
                    + (module_y * PVQR_MODULE_SIZE + pixel_y) * SCREEN_WIDTH
                    + module_x * PVQR_MODULE_SIZE;
                for (pixel_x = 0; pixel_x < PVQR_MODULE_SIZE; pixel_x++) {
                    row[pixel_x] = color;
                }
            }
        }
    }
}

static void show_frame(int page) {
    int hold;
    gpu_upload_frame(page);
    wait_vblank();
    gpu_gp1(UINT32_C(0x05000000) | ((uint32_t)(page ? SCREEN_HEIGHT : 0) << 10));
    for (hold = 1; hold < HOLD_VSYNCS; hold++) {
        wait_vblank();
    }
}

int main(void) {
    const volatile uint8_t *bios = (const volatile uint8_t *)BIOS_ADDRESS;
    const uint16_t chunk_count = (uint16_t)((BIOS_SIZE + PVQR_PAYLOAD_SIZE - 1) / PVQR_PAYLOAD_SIZE);
    const uint32_t image_crc = pvqr_crc32(bios, BIOS_SIZE);
    const uint32_t transfer_id = image_crc ^ BIOS_SIZE ^ TRANSFER_XOR;
    int page = 0;
    uint16_t chunk_index;

    gpu_initialize();

    for (;;) {
        for (chunk_index = 0; chunk_index < chunk_count; chunk_index++) {
            uint32_t offset = (uint32_t)chunk_index * PVQR_PAYLOAD_SIZE;
            uint32_t remaining = BIOS_SIZE - offset;
            uint16_t payload_size = (uint16_t)(remaining < PVQR_PAYLOAD_SIZE ? remaining : PVQR_PAYLOAD_SIZE);

            pvqr_build_packet(
                packet,
                bios + offset,
                payload_size,
                transfer_id,
                chunk_index,
                chunk_count,
                BIOS_SIZE,
                image_crc
            );
            pvqr_packet_to_matrix(matrix, packet);
            render_matrix();
            show_frame(page);
            page ^= 1;
        }
    }
}
