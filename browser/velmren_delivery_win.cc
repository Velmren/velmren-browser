/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/velmren_delivery_win.h"

#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <string>
#include <string_view>
#include <utility>

#include "base/base_paths.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/path_service.h"
#include "base/process/process_handle.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/version.h"
#include "base/win/scoped_handle.h"
#include "base/win/scoped_process_information.h"

namespace velmren::delivery {

namespace {

bool HasName(const base::FilePath& path, std::wstring_view name) {
  return base::EqualsCaseInsensitiveASCII(path.BaseName().value(), name);
}

bool IsRegularFile(const base::FilePath& path) {
  const DWORD attributes = ::GetFileAttributesW(path.value().c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         !(attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
}

bool HasUnlinkedParents(base::FilePath path) {
  while (true) {
    const DWORD attributes = ::GetFileAttributesW(path.value().c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
      return false;
    }
    const auto parent = path.DirName();
    if (parent == path) {
      return true;
    }
    path = parent;
  }
}

base::win::ScopedHandle LaunchUpdateMonitor(const base::FilePath& root,
                                          base::ProcessId browser_pid) {
  base::CommandLine command(root.Append(FILE_PATH_LITERAL("Velmren.exe")));
  // AppendArg preserves the delivery verb before its options. AppendSwitch
  // would move the options before the verb and change the launcher's command.
  command.AppendArg("monitor");
  command.AppendArgNative(L"--root=" + root.value());
  command.AppendArg("--browser-pid=" + base::NumberToString(browser_pid));
  std::wstring command_line = command.GetCommandLineString();
  STARTUPINFOW startup_info = {};
  startup_info.cb = sizeof(startup_info);
  startup_info.dwFlags = STARTF_USESHOWWINDOW | STARTF_FORCEOFFFEEDBACK;
  startup_info.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION process_info = {};
  if (!::CreateProcessW(command.GetProgram().value().c_str(), command_line.data(),
                       nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                       root.value().c_str(), &startup_info, &process_info)) {
    PLOG(WARNING) << "Could not start the Velmren update monitor";
    return {};
  }
  base::win::ScopedProcessInformation process(process_info);
  return base::win::ScopedHandle(process.TakeProcessHandle());
}

void MaintainUpdateMonitor(base::FilePath executable,
                          base::ProcessId browser_pid,
                          base::win::ScopedHandle monitor) {
  if (!monitor.is_valid() ||
      ::WaitForSingleObject(monitor.get(), 0) != WAIT_TIMEOUT) {
    const auto root = FindInstalledRoot(executable);
    if (!root) {
      return;
    }
    monitor = LaunchUpdateMonitor(*root, browser_pid);
  }
  // A live monitor shadow-waits if another launcher owns the update lease.
  // Delayed probes recover an exited monitor without a shutdown-blocking wait.
  base::ThreadPool::PostDelayedTask(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::BEST_EFFORT,
       base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
      base::BindOnce(&MaintainUpdateMonitor, executable, browser_pid,
                    std::move(monitor)),
      base::Seconds(30));
}

}  // namespace

std::optional<base::FilePath> FindInstalledRoot(
    const base::FilePath& executable) {
  if (!executable.IsAbsolute() || executable.ReferencesParent() ||
      !HasName(executable, L"velmren.exe")) {
    return std::nullopt;
  }
  const auto browser_directory = executable.DirName();
  const auto app_directory = browser_directory.DirName();
  const auto version_directory = app_directory.DirName();
  const auto versions_directory = version_directory.DirName();
  const auto root = versions_directory.DirName();
  if (!HasName(browser_directory, L"browser") ||
      !HasName(app_directory, L"app") ||
      !HasName(versions_directory, L"versions") || root == versions_directory) {
    return std::nullopt;
  }
  const auto version_text = version_directory.BaseName().MaybeAsASCII();
  const base::Version version(version_text);
  if (!version.IsValid() || version.components().size() != 4 ||
      version.GetString() != version_text ||
      std::ranges::any_of(version.components(), [](uint32_t part) {
        return part > static_cast<uint32_t>(std::numeric_limits<int>::max());
      })) {
    return std::nullopt;
  }
  if (!IsRegularFile(executable) || !HasUnlinkedParents(browser_directory) ||
      !IsRegularFile(root.Append(FILE_PATH_LITERAL(".velmren-owner.json"))) ||
      !IsRegularFile(root.Append(FILE_PATH_LITERAL("installation.json"))) ||
      !IsRegularFile(root.Append(FILE_PATH_LITERAL("Velmren.exe")))) {
    return std::nullopt;
  }
  return root;
}

std::optional<base::CommandLine> MakeBrowserCommand(
    const base::FilePath& executable,
    const base::FilePath& profile_path,
    bool incognito,
    bool new_window) {
  const auto root = FindInstalledRoot(executable);
  if (!root || !profile_path.IsAbsolute() || profile_path.ReferencesParent() ||
      profile_path.DirName() == profile_path) {
    return std::nullopt;
  }
  base::CommandLine command(root->Append(FILE_PATH_LITERAL("Velmren.exe")));
  command.AppendArg("launch");
  command.AppendArgNative(L"--root=" + root->value());
  command.AppendArgNative(L"--user-data-dir=" + profile_path.DirName().value());
  command.AppendArgNative(L"--profile-directory=" +
                         profile_path.BaseName().value());
  if (incognito) {
    command.AppendArg("--incognito=true");
  }
  if (new_window) {
    command.AppendArg("--new-window=true");
  }
  return command;
}

std::optional<base::CommandLine> MakeRelaunchCommand(
    const base::FilePath& executable,
    const base::FilePath& user_data_dir,
    const base::CommandLine& relaunch_command,
    base::ProcessId browser_pid,
    bool update_ready) {
  if (!update_ready || browser_pid == base::kNullProcessId ||
      !relaunch_command.HasSwitch("restart") ||
      !IsOrdinaryBrowserCommand(relaunch_command) ||
      relaunch_command.HasSwitch("isolated") || !user_data_dir.IsAbsolute() ||
      user_data_dir.ReferencesParent() ||
      user_data_dir.DirName() == user_data_dir) {
    return std::nullopt;
  }
  const auto root = FindInstalledRoot(executable);
  if (!root || !IsRegularFile(root->Append(FILE_PATH_LITERAL("pending.json")))) {
    return std::nullopt;
  }

  const auto profile = relaunch_command.GetSwitchValueNative("profile-directory");
  if (relaunch_command.HasSwitch("profile-directory") &&
      (profile.empty() || profile == L"." || profile == L".." ||
       profile.find_first_of(L"<>:\"/\\|?*") != std::wstring::npos ||
       profile.find(L'\0') != std::wstring::npos || profile.back() == L'.' ||
       profile.back() == L' ')) {
    return std::nullopt;
  }

  base::CommandLine command(root->Append(FILE_PATH_LITERAL("Velmren.exe")));
  command.AppendArg("relaunch");
  command.AppendArgNative(L"--root=" + root->value());
  command.AppendArg("--browser-pid=" + base::NumberToString(browser_pid));
  command.AppendArgNative(L"--user-data-dir=" + user_data_dir.value());
  if (!profile.empty()) {
    command.AppendArgNative(L"--profile-directory=" + profile);
  }
  if (relaunch_command.HasSwitch("incognito")) {
    command.AppendArg("--incognito=true");
  }
  command.AppendArg("--restore-session=true");
  return command;
}

bool IsOrdinaryBrowserCommand(const base::CommandLine& command_line) {
  for (const char* excluded : {"type", "headless", "velmren-agent-mode",
                              "enable-automation", "test-type"}) {
    if (command_line.HasSwitch(excluded)) {
      return false;
    }
  }
  return true;
}

void MaybeLaunchUpdateMonitor() {
  if (!IsOrdinaryBrowserCommand(*base::CommandLine::ForCurrentProcess())) {
    return;
  }
  base::FilePath executable;
  if (!base::PathService::Get(base::FILE_EXE, &executable)) {
    return;
  }
  base::ThreadPool::PostTask(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::BEST_EFFORT,
       base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
      base::BindOnce(&MaintainUpdateMonitor, executable, base::GetCurrentProcId(),
                    base::win::ScopedHandle()));
}

}  // namespace velmren::delivery
