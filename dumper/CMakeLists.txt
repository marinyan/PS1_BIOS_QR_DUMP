cmake_minimum_required(VERSION 3.21)
project(ps1biosqr_dumper LANGUAGES C ASM)

find_package(Python3 3.10 REQUIRED COMPONENTS Interpreter)

add_executable(ps1biosqr_elf
    start.S
    main.c
    protocol.c
)
set_target_properties(ps1biosqr_elf PROPERTIES
    OUTPUT_NAME ps1biosqr
    SUFFIX ".elf"
)

target_compile_options(ps1biosqr_elf PRIVATE
    -mips1
    -mabi=32
    -EL
    -G0
    -ffreestanding
    -fno-builtin
    -fno-pic
    -mno-abicalls
    -ffunction-sections
    -fdata-sections
    $<$<COMPILE_LANGUAGE:C>:-O2;-Wall;-Wextra;-Wpedantic;-std=c11>
)
target_link_options(ps1biosqr_elf PRIVATE
    -mips1
    -mabi=32
    -EL
    -G0
    -nostdlib
    -nostartfiles
    -nodefaultlibs
    -mno-abicalls
    -Wl,-T,${CMAKE_CURRENT_SOURCE_DIR}/linker.ld
    -Wl,--gc-sections
    -Wl,-Map,${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.map
)

add_custom_command(
    OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.exe
    COMMAND ${Python3_EXECUTABLE}
        ${CMAKE_CURRENT_SOURCE_DIR}/tools/elf2psx.py
        $<TARGET_FILE:ps1biosqr_elf>
        ${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.exe
    DEPENDS ps1biosqr_elf ${CMAKE_CURRENT_SOURCE_DIR}/tools/elf2psx.py
    VERBATIM
)
add_custom_target(ps1biosqr_exe ALL
    DEPENDS ${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.exe
)
