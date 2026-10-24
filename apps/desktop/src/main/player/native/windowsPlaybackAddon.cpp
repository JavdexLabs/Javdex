#include <node_api.h>

napi_value initializeWindowsSharedTexture(napi_env env, napi_value exports);
napi_value initializeWindowsSoftwarePlayback(napi_env env, napi_value exports);

napi_value initialize(napi_env env, napi_value exports) {
    // A rejected Worker import must not attach cleanup hooks to the main
    // thread's live software session.
    const auto initialized = initializeWindowsSharedTexture(env, exports);
    return initialized ? initializeWindowsSoftwarePlayback(env, initialized) : nullptr;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
