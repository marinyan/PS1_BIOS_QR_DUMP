#include <stddef.h>
#include <stdint.h>

#include "protocol.h"

#define SCREEN_WIDTH (PVQR_GRID_WIDTH * PVQR_MODULE_SIZE)
#define SCREEN_HEIGHT (PVQR_GRID_HEIGHT * PVQR_MODULE_SIZE)
#define BIOS_ADDRESS UINT32_C(0xBFC00000)
#define BIOS_SIZE UINT32_C(0x00080000)
#define HOLD_VSYNCS 3
#define TRANSFER_XOR UINT32_C(0x50565152)

#define TEXTURE_X 320
#define TEXTURE_Y 0
#define TEXTURE_WIDTH_HALFWORDS (PVQR_GRID_WIDTH / 4)
#define TEXTURE_WORD_COUNT ((PVQR_GRID_WIDTH * PVQR_GRID_HEIGHT) / 8)
#define CLUT_X 512
#define CLUT_Y 0
#define CLUT_COLOR_COUNT 16
#define TEXTURE_DRAW_INSET (PVQR_MODULE_SIZE / 2)
#define TEXTURE_PAGE_ATTRIBUTE ((TEXTURE_X / 64) | ((TEXTURE_Y / 256) << 4))
#define CLUT_ATTRIBUTE ((CLUT_X / 16) | (CLUT_Y << 6))

#define GPU_GP0 (*(volatile uint32_t *)UINT32_C(0xBF801810))
#define GPU_STAT (*(volatile uint32_t *)UINT32_C(0xBF801814))
#define GPU_GP1 (*(volatile uint32_t *)UINT32_C(0xBF801814))
#define IRQ_STATUS (*(volatile uint32_t *)UINT32_C(0xBF801070))

#define GPU_READY_COMMAND (UINT32_C(1) << 26)
#define IRQ_VBLANK UINT32_C(1)

static const uint16_t palette[CLUT_COLOR_COUNT] = {
    0x8000u,
    0x7C00u,
    0x03E0u,
    0x7FE0u,
    0x001Fu,
    0x7C1Fu,
    0x03FFu,
    0x7FFFu,
    0x8000u,
    0x8000u,
    0x8000u,
    0x8000u,
    0x8000u,
    0x8000u,
    0x8000u,
    0x8000u
};

static uint32_t texture_words[TEXTURE_WORD_COUNT];
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

static void gpu_upload_clut(void) {
    size_t index;

    gpu_gp0(UINT32_C(0xA0000000));
    gpu_gp0(((uint32_t)CLUT_Y << 16) | CLUT_X);
    gpu_gp0((UINT32_C(1) << 16) | CLUT_COLOR_COUNT);
    for (index = 0; index < CLUT_COLOR_COUNT; index += 2) {
        uint32_t pair = palette[index] | ((uint32_t)palette[index + 1] << 16);
        gpu_gp0(pair);
    }
}

static void gpu_clear_framebuffers(void) {
    gpu_gp0(UINT32_C(0x02000000));
    gpu_gp0(UINT32_C(0x00000000));
    gpu_gp0(((uint32_t)(SCREEN_HEIGHT * 2) << 16) | SCREEN_WIDTH);
}

static void pack_texture(void) {
    int y;
    int x;
    size_t output = 0;

    for (y = 0; y < PVQR_GRID_HEIGHT; y++) {
        for (x = 0; x < PVQR_GRID_WIDTH; x += 8) {
            uint32_t word = 0;
            int pixel;
            for (pixel = 0; pixel < 8; pixel++) {
                word |= (uint32_t)(matrix[y][x + pixel] & 7) << (pixel * 4);
            }
            texture_words[output++] = word;
        }
    }
}

static void gpu_upload_texture(void) {
    size_t index;

    gpu_gp0(UINT32_C(0xA0000000));
    gpu_gp0(((uint32_t)TEXTURE_Y << 16) | TEXTURE_X);
    gpu_gp0(((uint32_t)PVQR_GRID_HEIGHT << 16) | TEXTURE_WIDTH_HALFWORDS);
    for (index = 0; index < TEXTURE_WORD_COUNT; index++) {
        gpu_gp0(texture_words[index]);
    }
    gpu_gp0(UINT32_C(0x01000000));
}

static void gpu_draw_texture(int page) {
    uint32_t page_y = page ? SCREEN_HEIGHT : 0;

    gpu_gp0(UINT32_C(0xE1000000) | TEXTURE_PAGE_ATTRIBUTE);
    gpu_gp0(UINT32_C(0xE3000000) | (page_y << 10));
    gpu_gp0(UINT32_C(0xE4000000)
        | ((page_y + SCREEN_HEIGHT - 1) << 10)
        | (SCREEN_WIDTH - 1));
    gpu_gp0(UINT32_C(0xE5000000) | (page_y << 11));
    gpu_gp0(UINT32_C(0xE6000000));

    /*
     * Polygon texture coordinates address texel centers. Moving the quad by
     * half a module aligns the 40x30 texels with the 8-pixel output grid.
     * The clipped top/left strips are safe because the protocol border is
     * always black and both framebuffers are cleared once at startup.
     */
    gpu_gp0(UINT32_C(0x2D000000));
    gpu_gp0(((uint32_t)TEXTURE_DRAW_INSET << 16) | TEXTURE_DRAW_INSET);
    gpu_gp0(((uint32_t)CLUT_ATTRIBUTE << 16));
    gpu_gp0(((uint32_t)TEXTURE_DRAW_INSET << 16)
        | (SCREEN_WIDTH + TEXTURE_DRAW_INSET));
    gpu_gp0(((uint32_t)TEXTURE_PAGE_ATTRIBUTE << 16) | PVQR_GRID_WIDTH);
    gpu_gp0(((uint32_t)(SCREEN_HEIGHT + TEXTURE_DRAW_INSET) << 16)
        | TEXTURE_DRAW_INSET);
    gpu_gp0((uint32_t)PVQR_GRID_HEIGHT << 8);
    gpu_gp0(((uint32_t)(SCREEN_HEIGHT + TEXTURE_DRAW_INSET) << 16)
        | (SCREEN_WIDTH + TEXTURE_DRAW_INSET));
    gpu_gp0(((uint32_t)PVQR_GRID_HEIGHT << 8) | PVQR_GRID_WIDTH);
}

static void show_frame(int page) {
    int hold;
    gpu_upload_texture();
    gpu_draw_texture(page);
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
    int page = 1;
    uint16_t chunk_index;

    gpu_initialize();
    gpu_clear_framebuffers();
    gpu_upload_clut();

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
            pack_texture();
            show_frame(page);
            page ^= 1;
        }
    }
}
