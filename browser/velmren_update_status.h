/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_BROWSER_VELMREN_UPDATE_STATUS_H_
#define BRAVE_BROWSER_VELMREN_UPDATE_STATUS_H_

#include <string>
#include <string_view>

#include "base/callback_list.h"
#include "base/files/file_path.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/timer/timer.h"

namespace base {
template <typename T>
class NoDestructor;
}

namespace velmren::delivery {

enum class UpdatePhase {
  kUnknown,
  kChecking,
  kAvailable,
  kDownloading,
  kInstalling,
  kReady,
  kUpToDate,
  kError
};

struct UpdateStatus {
  UpdatePhase phase = UpdatePhase::kUnknown;
  std::string installed_version;
  std::string available_version;
  std::string error_code;
  bool relaunch_blocked = false;
  base::Time updated_at;
  base::Time last_checked_at;
  bool operator==(const UpdateStatus&) const = default;
};

// Display-only state. The launcher independently validates every activation.
UpdateStatus ReadUpdateStatus(const base::FilePath& root,
                              std::string_view running_version,
                              base::Time now);
const char* UpdatePhaseName(UpdatePhase phase);

// All access is on the UI sequence; file and process work uses ThreadPool.
class UpdateStatusMonitor {
 public:
  static UpdateStatusMonitor* GetInstance();
  const UpdateStatus& status() const { return status_; }
  bool supported() const { return !root_.empty(); }
  base::CallbackListSubscription AddObserver(base::RepeatingClosure callback);
  void Refresh();
  void CheckNow();

 private:
  friend class base::NoDestructor<UpdateStatusMonitor>;
  friend class UpdateStatusMonitorTestApi;
  UpdateStatusMonitor();
  ~UpdateStatusMonitor();
  void OnRead(UpdateStatus status);
  void OnCheckStarted(bool started);

  base::FilePath root_;
  std::string running_version_;
  UpdateStatus status_;
  base::RepeatingClosureList observers_;
  base::RepeatingTimer timer_;
  bool reading_ = false;
  bool starting_check_ = false;
  bool waiting_for_check_status_ = false;
  base::Time last_check_request_;
  base::WeakPtrFactory<UpdateStatusMonitor> weak_factory_{this};
};

}  // namespace velmren::delivery

#endif  // BRAVE_BROWSER_VELMREN_UPDATE_STATUS_H_
