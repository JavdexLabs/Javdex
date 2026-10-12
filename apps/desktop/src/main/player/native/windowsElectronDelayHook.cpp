// SPDX-License-Identifier: GPL-3.0-or-later
// MinGW delay-load imports name node.exe; a packaged Electron executable may
// have another name. Resolve that import to the running host's export table.
#include <windows.h>
#include <delayimp.h>

static FARPROC WINAPI electronHost(unsigned int event, DelayLoadInfo *info) {
    if (event != dliNotePreLoadLibrary || !info || !info->szDll || lstrcmpiA(info->szDll, "node.exe") != 0) return nullptr;
    return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = electronHost;
