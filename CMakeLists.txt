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

# Version shown to the GUI, from git (evaluated when CMake configures, so re-run
# "cmake -S . -B build" to refresh it).
find_package(Git QUIET)
set(DH_COUNT 0)
set(DH_HASH nogit)
set(DH_DIRTY "")
if(GIT_FOUND)
  execute_process(COMMAND ${GIT_EXECUTABLE} rev-list --count HEAD WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
                  OUTPUT_VARIABLE DH_COUNT OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
  execute_process(COMMAND ${GIT_EXECUTABLE} rev-parse --short HEAD WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
                  OUTPUT_VARIABLE DH_HASH OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
  execute_process(COMMAND ${GIT_EXECUTABLE} diff --quiet HEAD -- src WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
                  RESULT_VARIABLE DH_DIRTY_RESULT ERROR_QUIET)
  if(NOT DH_DIRTY_RESULT EQUAL 0)
    set(DH_DIRTY "+")
  endif()
endif()
string(TIMESTAMP DH_TIME "%Y-%m-%d %H:%M")
target_compile_definitions(darkhelmet PRIVATE
  ENGINE_VERSION="build ${DH_COUNT}${DH_DIRTY} (${DH_HASH} ${DH_TIME})")
find_package(Threads REQUIRED)
target_link_libraries(darkhelmet Threads::Threads)
if(NOT MSVC)
  target_link_libraries(darkhelmet m)
endif()
