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
        jstring jcwd, jstring jscript, jint port, jstring jhost) {

    const char *cwd = env->GetStringUTFChars(jcwd, nullptr);
    const char *script = env->GetStringUTFChars(jscript, nullptr);
    const char *host = env->GetStringUTFChars(jhost, nullptr);

    chdir(cwd);
    setenv("PORT", std::to_string(port).c_str(), 1);
    setenv("HOST", host, 1);

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
