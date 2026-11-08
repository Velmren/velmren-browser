/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/velmren_update_status.h"

#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <utility>

#include "base/base_paths.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/process/launch.h"
#include "base/process/process_handle.h"
#include "base/process/process_iterator.h"
#include "base/task/thread_pool.h"
#include "base/values.h"
#include "base/version.h"
#include "brave/browser/velmren_delivery_win.h"

namespace velmren::delivery {
namespace {

constexpr size_t kMaximumStatusBytes = 16384;

bool IsPlainFile(const base::FilePath& path) {
  const DWORD attributes = ::GetFileAttributesW(path.value().c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         !(attributes &
           (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
}

std::optional<base::DictValue> ReadObject(const base::FilePath& path) {
  std::string contents;
  if (!IsPlainFile(path) || !base::ReadFileToStringWithMaxSize(
                                path, &contents, kMaximumStatusBytes)) {
    return std::nullopt;
  }
  return base::JSONReader::ReadDict(contents, base::JSON_PARSE_RFC);
}

bool CanonicalVersion(std::string_view text) {
  const base::Version version(text);
  return version.IsValid() && version.components().size() == 4 &&
         version.GetString() == text &&
         std::ranges::all_of(version.components(), [](uint32_t part) {
           return part <=
                  static_cast<uint32_t>(std::numeric_limits<int32_t>::max());
         });
}

base::Time ReadTime(const base::DictValue& value, std::string_view name) {
  const auto* text = value.FindString(name);
  base::Time time;
  return text && base::Time::FromString(text->c_str(), &time) ? time
                                                              : base::Time();
}

bool StartCheck(const base::FilePath& root) {
  base::CommandLine command(root.Append(FILE_PATH_LITERAL("Velmren.exe")));
  command.AppendArg("update");
  command.AppendArgNative(L"--root=" + root.value());
  base::LaunchOptions options;
  options.start_hidden = true;
  options.current_directory = root;
  return base::LaunchProcess(command, options).IsValid();
}

bool HasOtherBrowserSession(const base::FilePath& root) {
  const base::ProcessId own_pid = base::GetCurrentProcId();
  base::NamedProcessIterator processes(FILE_PATH_LITERAL("velmren.exe"),
                                       nullptr);
  std::map<base::ProcessId, base::ProcessId> parents;
  for (const auto* process = processes.NextProcessEntry(); process;
       process = processes.NextProcessEntry()) {
    parents.emplace(process->pid(), process->parent_pid());
  }
  for (const auto& [pid, parent] : parents) {
    auto ancestor = pid;
    size_t depth = 0;
    while (ancestor != own_pid && parents.contains(ancestor) && depth++ < 64) {
      const auto next = parents.at(ancestor);
      if (next == ancestor) {
        break;
      }
      ancestor = next;
    }
    if (ancestor == own_pid) {
      continue;
    }
    base::Process process =
        base::Process::OpenWithAccess(pid, PROCESS_QUERY_LIMITED_INFORMATION);
    if (!process.IsValid()) {
      continue;
    }
    std::wstring image_path(32768, L'\0');
    DWORD path_length = static_cast<DWORD>(image_path.size());
    if (!::QueryFullProcessImageNameW(process.Handle(), 0, image_path.data(),
                                      &path_length)) {
      continue;
    }
    image_path.resize(path_length);
    const auto other_root = FindInstalledRoot(base::FilePath(image_path));
    if (other_root && *other_root == root) {
      return true;
    }
  }
  return false;
}

UpdateStatus ReadForBrowser(const base::FilePath& root,
                            const std::string& version) {
  auto status = ReadUpdateStatus(root, version, base::Time::Now());
  if (status.phase == UpdatePhase::kReady) {
    status.relaunch_blocked = HasOtherBrowserSession(root);
  }
  return status;
}

}  // namespace

const char* UpdatePhaseName(UpdatePhase phase) {
  switch (phase) {
    case UpdatePhase::kUnknown:
      return "unknown";
    case UpdatePhase::kChecking:
      return "checking";
    case UpdatePhase::kAvailable:
      return "available";
    case UpdatePhase::kDownloading:
      return "downloading";
    case UpdatePhase::kInstalling:
      return "installing";
    case UpdatePhase::kReady:
      return "ready";
    case UpdatePhase::kUpToDate:
      return "up-to-date";
    case UpdatePhase::kError:
      return "error";
  }
}

UpdateStatus ReadUpdateStatus(const base::FilePath& root,
                              std::string_view running_version,
                              base::Time now) {
  UpdateStatus status;
  status.installed_version = running_version;
  if (!CanonicalVersion(running_version)) {
    return status;
  }
  const auto value =
      ReadObject(root.Append(FILE_PATH_LITERAL("update-status.json")));
  if (!value || value->FindInt("schema") != 1) {
    return status;
  }
  const auto* phase = value->FindString("phase");
  const auto* installed = value->FindString("installedVersion");
  const auto* available = value->FindString("availableVersion");
  status.updated_at = ReadTime(*value, "updatedAt");
  status.last_checked_at = ReadTime(*value, "lastCheckedAt");
  if (status.last_checked_at > now + base::Minutes(5)) {
    status.last_checked_at = base::Time();
  }
  if (!phase || !installed || *installed != running_version ||
      status.updated_at.is_null() ||
      status.updated_at > now + base::Minutes(5)) {
    return status;
  }
  if (*phase == "checking") {
    status.phase = UpdatePhase::kChecking;
  } else if (*phase == "available") {
    status.phase = UpdatePhase::kAvailable;
  } else if (*phase == "downloading") {
    status.phase = UpdatePhase::kDownloading;
  } else if (*phase == "installing") {
    status.phase = UpdatePhase::kInstalling;
  } else if (*phase == "ready") {
    status.phase = UpdatePhase::kReady;
  } else if (*phase == "up-to-date") {
    status.phase = UpdatePhase::kUpToDate;
  } else if (*phase == "error") {
    status.phase = UpdatePhase::kError;
  }

  if (available && CanonicalVersion(*available) &&
      base::Version(*available) > base::Version(running_version)) {
    status.available_version = *available;
  }
  if (status.phase == UpdatePhase::kAvailable ||
      status.phase == UpdatePhase::kDownloading ||
      status.phase == UpdatePhase::kInstalling ||
      status.phase == UpdatePhase::kReady) {
    if (status.available_version.empty()) {
      status.phase = UpdatePhase::kUnknown;
    }
  }
  if (status.phase == UpdatePhase::kReady) {
    const auto pending =
        ReadObject(root.Append(FILE_PATH_LITERAL("pending.json")));
    if (!pending || !pending->FindString("version") ||
        *pending->FindString("version") != status.available_version) {
      status.phase = UpdatePhase::kUnknown;
    }
  }
  const bool busy = status.phase == UpdatePhase::kChecking ||
                    status.phase == UpdatePhase::kAvailable ||
                    status.phase == UpdatePhase::kDownloading ||
                    status.phase == UpdatePhase::kInstalling;
  if (busy && now - status.updated_at > base::Minutes(30)) {
    status.phase = UpdatePhase::kError;
    status.error_code = "interrupted";
  } else if (status.phase == UpdatePhase::kUpToDate &&
             (status.last_checked_at.is_null() ||
              now - status.last_checked_at > base::Hours(24))) {
    status.phase = UpdatePhase::kUnknown;
  }
  if (status.phase == UpdatePhase::kError && status.error_code.empty()) {
    const auto* error = value->FindString("errorCode");
    status.error_code = error && *error == "activation-failed"
                            ? "activation-failed"
                            : "check-failed";
  }
  return status;
}

UpdateStatusMonitor* UpdateStatusMonitor::GetInstance() {
  static base::NoDestructor<UpdateStatusMonitor> instance;
  return instance.get();
}

UpdateStatusMonitor::UpdateStatusMonitor() {
  base::FilePath executable;
  if (base::PathService::Get(base::FILE_EXE, &executable) &&
      IsOrdinaryBrowserCommand(*base::CommandLine::ForCurrentProcess())) {
    if (auto root = FindInstalledRoot(executable)) {
      root_ = *root;
      running_version_ =
          executable.DirName().DirName().DirName().BaseName().MaybeAsASCII();
      status_.installed_version = running_version_;
    }
  }
}

UpdateStatusMonitor::~UpdateStatusMonitor() = default;

base::CallbackListSubscription UpdateStatusMonitor::AddObserver(
    base::RepeatingClosure callback) {
  if (supported() && !timer_.IsRunning()) {
    timer_.Start(FROM_HERE, base::Seconds(5), this,
                 &UpdateStatusMonitor::Refresh);
  }
  return observers_.Add(std::move(callback));
}

void UpdateStatusMonitor::Refresh() {
  if (observers_.empty()) {
    timer_.Stop();
    return;
  }
  if (!supported() || reading_) {
    return;
  }
  reading_ = true;
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
       base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
      base::BindOnce(&ReadForBrowser, root_, running_version_),
      base::BindOnce(&UpdateStatusMonitor::OnRead, weak_factory_.GetWeakPtr()));
}

void UpdateStatusMonitor::OnRead(UpdateStatus status) {
  reading_ = false;
  if (waiting_for_check_status_) {
    if (status.updated_at < last_check_request_) {
      if (base::Time::Now() - last_check_request_ < base::Seconds(30)) {
        return;
      }
      status = status_;
      status.phase = UpdatePhase::kError;
      status.error_code = "interrupted";
    } else {
      waiting_for_check_status_ = false;
    }
  }
  if (status_ == status) {
    return;
  }
  status_ = std::move(status);
  observers_.Notify();
}

void UpdateStatusMonitor::CheckNow() {
  const auto phase = status_.phase;
  if (!supported() || starting_check_ ||
      base::Time::Now() - last_check_request_ < base::Seconds(5) ||
      phase == UpdatePhase::kChecking || phase == UpdatePhase::kAvailable ||
      phase == UpdatePhase::kDownloading || phase == UpdatePhase::kInstalling) {
    Refresh();
    observers_.Notify();
    return;
  }
  starting_check_ = true;
  last_check_request_ = base::Time::Now();
  waiting_for_check_status_ = true;
  if (phase != UpdatePhase::kReady) {
    status_.phase = UpdatePhase::kChecking;
    status_.updated_at = last_check_request_;
    observers_.Notify();
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
       base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
      base::BindOnce(&StartCheck, root_),
      base::BindOnce(&UpdateStatusMonitor::OnCheckStarted,
                     weak_factory_.GetWeakPtr()));
}

void UpdateStatusMonitor::OnCheckStarted(bool started) {
  starting_check_ = false;
  if (started && status_.phase != UpdatePhase::kReady) {
    status_.phase = UpdatePhase::kChecking;
    status_.updated_at = base::Time::Now();
  } else if (!started) {
    status_.phase = UpdatePhase::kError;
    status_.error_code = "launch-failed";
  }
  observers_.Notify();
  Refresh();
}

}  // namespace velmren::delivery
