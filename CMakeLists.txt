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
