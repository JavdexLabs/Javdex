#include "softwarePlayback.h"

napi_value initializeWindowsSoftwarePlayback(napi_env env, napi_value exports) {
    return javdex_software::initialize(env, exports, "windows-software");
}
