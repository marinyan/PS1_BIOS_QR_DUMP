OUTPUT_ARCH(mips)
ENTRY(_start)

PHDRS
{
    ram PT_LOAD FLAGS(7);
}

SECTIONS
{
    . = 0x80010000;

    .text : ALIGN(4)
    {
        KEEP(*(.text.start))
        *(.text .text.*)
        *(.rodata .rodata.*)
    } :ram

    .data : ALIGN(4)
    {
        *(.data .data.*)
        *(.sdata .sdata.*)
    } :ram

    . = ALIGN(16);
    __bss_start = .;
    .bss (NOLOAD) :
    {
        *(.bss .bss.*)
        *(.sbss .sbss.*)
        *(COMMON)
    } :ram
    . = ALIGN(16);
    __bss_end = .;

    /DISCARD/ :
    {
        *(.comment)
        *(.note*)
        *(.MIPS.abiflags)
        *(.reginfo)
    }
}
