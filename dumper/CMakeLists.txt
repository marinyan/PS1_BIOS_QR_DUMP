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

# mkpsxiso is a host-side optional tool. The normal SDK-free PS-X EXE build
# remains available when it is not installed.
find_program(MKPSXISO_EXECUTABLE NAMES mkpsxiso mkpsxiso.exe)
if(MKPSXISO_EXECUTABLE)
    file(TO_CMAKE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/disc/system.cnf" DISC_SYSTEM_CNF)
    file(TO_CMAKE_PATH "${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.exe" DISC_PSX_EXE)
    file(TO_CMAKE_PATH "${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.bin" DISC_IMAGE)
    file(TO_CMAKE_PATH "${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.cue" DISC_CUE)
    configure_file(
        ${CMAKE_CURRENT_SOURCE_DIR}/disc/disc.xml.in
        ${CMAKE_CURRENT_BINARY_DIR}/disc.xml
        @ONLY
    )

    add_custom_command(
        OUTPUT
            ${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.bin
            ${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.cue
        COMMAND ${MKPSXISO_EXECUTABLE}
            -y
            ${CMAKE_CURRENT_BINARY_DIR}/disc.xml
        DEPENDS
            ps1biosqr_exe
            ${CMAKE_CURRENT_SOURCE_DIR}/disc/system.cnf
            ${CMAKE_CURRENT_BINARY_DIR}/disc.xml
        WORKING_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}
        VERBATIM
    )
    add_custom_target(ps1biosqr_disc
        DEPENDS
            ${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.bin
            ${CMAKE_CURRENT_BINARY_DIR}/ps1biosqr.cue
    )
else()
    message(STATUS "mkpsxiso not found; ps1biosqr_disc target will not be available")
endif()
