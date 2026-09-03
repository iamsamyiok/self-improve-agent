#include <pthread.h>
#include <jni.h>
#include <cstdlib>
#include <cstring>

// nodejs-mobile v18.20.4 的 libnode.so 导出 C++ 入口 node::Start（无 C 版 node_start，
// 已用 nm -D 验证 _ZN4node5StartEiPPc 为导出符号）
namespace node { int Start(int argc, char *argv[]); }

namespace {

struct StartArgs {
    int argc;
    char **argv;
};

void *start_routine(void *raw) {
    auto *a = static_cast<StartArgs *>(raw);
    node::Start(a->argc, a->argv);
    return nullptr;
}

} // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_hwj_agent_NodeRuntime_startNodeWithArguments(JNIEnv *env, jobject /*thiz*/,
                                                      jobjectArray arguments) {
    const int argc = env->GetArrayLength(arguments);
    char **argv = static_cast<char **>(malloc(sizeof(char *) * (argc + 1)));
    for (int i = 0; i < argc; i++) {
        auto js = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char *utf = env->GetStringUTFChars(js, nullptr);
        argv[i] = strdup(utf);
        env->ReleaseStringUTFChars(js, utf);
        env->DeleteLocalRef(js);
    }
    argv[argc] = nullptr;

    pthread_t t;
    pthread_create(&t, nullptr, start_routine, new StartArgs{argc, argv});
    pthread_detach(t);
}
