cmake_minimum_required(VERSION 3.18)
project(hwj_node_bridge)

# libnode.so 与头文件由 copy-native.sh 从 nodejs-mobile 发行包复制到本目录
set(NODE_PREBUILT ${CMAKE_CURRENT_SOURCE_DIR}/nodejs-mobile)

add_library(node_bridge SHARED node_bridge.cpp)

target_include_directories(node_bridge PRIVATE ${NODE_PREBUILT}/include)

# 链接预编译 libnode（运行时由 Java 侧 System.loadLibrary("node") 先行加载，
# 此处 GROUP 标记避免链接器弃用未引用符号）
find_library(log-lib log)
target_link_libraries(node_bridge ${NODE_PREBUILT}/${ANDROID_ABI}/libnode.so ${log-lib})
