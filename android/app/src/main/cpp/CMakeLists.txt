cmake_minimum_required(VERSION 3.22)
project(node_launcher LANGUAGES CXX)

# libnode.so comes from nodejs-mobile (tools/apk/fetch-libnode.mjs) and is packaged
# as a regular jniLib; the launcher only bridges JNI -> node::Start().
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
        IMPORTED_LOCATION ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

add_library(node_launcher SHARED node_launcher.cpp)

# NDK clang on Windows silently drops -I entries containing "..", so the include
# path must be normalized to a plain absolute path.
get_filename_component(NODE_INCLUDE_ABS "${CMAKE_CURRENT_SOURCE_DIR}/../../../../node-include/node" ABSOLUTE)
target_include_directories(node_launcher PRIVATE ${NODE_INCLUDE_ABS})

target_link_libraries(node_launcher node log)
