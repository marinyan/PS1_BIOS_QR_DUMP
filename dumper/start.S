    .set noreorder
    .set noat

    .section .text.start, "ax", @progbits
    .globl _start
    .type _start, @function

_start:
    lui     $sp, 0x8020
    addiu   $sp, $sp, -0x0100

    la      $t0, __bss_start
    la      $t1, __bss_end

1:
    sltu    $t2, $t0, $t1
    beq     $t2, $zero, 2f
    nop
    sw      $zero, 0($t0)
    addiu   $t0, $t0, 4
    b       1b
    nop

2:
    jal     main
    nop

3:
    b       3b
    nop

    .size _start, . - _start
