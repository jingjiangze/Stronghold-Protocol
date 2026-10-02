// node_launcher.cpp — bridges the Android world into an embedded Node.js runtime
// (nodejs-mobile libnode). Runs `node server/index.js` for the host-server mode.
#include <jni.h>
#include <string>
#include <vector>
#include <cstdlib>
#include <unistd.h>

#include "node.h"

extern "C" JNIEXPORT jint JNICALL
Java_icu_jiangjiangze_stronghold_NodeRunner_startNodeWithArguments(
        JNIEnv *env, jclass /*clazz*/,
        jstring jcwd, jstring jscript, jint port, jstring jhost, jobjectArray envPairs) {

    const char *cwd = env->GetStringUTFChars(jcwd, nullptr);
    const char *script = env->GetStringUTFChars(jscript, nullptr);
    const char *host = env->GetStringUTFChars(jhost, nullptr);

    chdir(cwd);
    setenv("PORT", std::to_string(port).c_str(), 1);
    setenv("HOST", host, 1);
    if (envPairs != nullptr) {
        jsize n = env->GetArrayLength(envPairs);
        for (jsize i = 0; i < n; i++) {
            jstring jpair = (jstring) env->GetObjectArrayElement(envPairs, i);
            if (jpair == nullptr) continue;
            const char *pair = env->GetStringUTFChars(jpair, nullptr);
            std::string s(pair);
            size_t eq = s.find('=');
            if (eq != std::string::npos && eq > 0) {
                setenv(s.substr(0, eq).c_str(), s.substr(eq + 1).c_str(), 1);
            }
            env->ReleaseStringUTFChars(jpair, pair);
        }
    }

    // node::Start mutates argv strings, so give them mutable storage that outlives the call.
    std::string arg0 = "node";
    std::string arg1 = script;
    std::vector<char *> argv;
    argv.push_back(arg0.data());
    argv.push_back(arg1.data());

    int code = node::Start(static_cast<int>(argv.size()), argv.data());

    env->ReleaseStringUTFChars(jcwd, cwd);
    env->ReleaseStringUTFChars(jscript, script);
    env->ReleaseStringUTFChars(jhost, host);
    return code;
}
