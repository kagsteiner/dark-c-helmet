cmake_minimum_required(VERSION 3.16)
project(VibeChessEngineC C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(MSVC)
  add_compile_options(/O2 /W3)
else()
  add_compile_options(-O3 -Wall -Wextra -Wpedantic)
endif()

add_executable(vibechess_c engine_c.c)

# New engine (bitboards), sources in src/
file(GLOB DARKHELMET_SOURCES CONFIGURE_DEPENDS ${CMAKE_SOURCE_DIR}/src/*.c)
add_executable(darkhelmet ${DARKHELMET_SOURCES})
if(NOT MSVC)
  target_link_libraries(darkhelmet m)
endif()
