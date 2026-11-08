/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_BROWSER_UI_TOOLBAR_VELMREN_UPDATE_MENU_H_
#define BRAVE_BROWSER_UI_TOOLBAR_VELMREN_UPDATE_MENU_H_

#include "base/notreached.h"
#include "brave/browser/velmren_update_status.h"
#include "brave/grit/brave_generated_resources.h"

namespace velmren::delivery {

struct UpdateMenuPresentation {
  int label_id;
  int tooltip_id;
  bool highlight;
};

// Header and menu share wording, but only actionable update phases get a chip.
inline UpdateMenuPresentation GetUpdateMenuPresentation(UpdatePhase phase) {
  switch (phase) {
    case UpdatePhase::kUnknown:
      return {IDS_VELMREN_UPDATE_UNKNOWN_LABEL,
              IDS_VELMREN_UPDATE_UNKNOWN_TOOLTIP, false};
    case UpdatePhase::kChecking:
      return {IDS_VELMREN_UPDATE_CHECKING_LABEL,
              IDS_VELMREN_UPDATE_CHECKING_TOOLTIP, false};
    case UpdatePhase::kAvailable:
      return {IDS_VELMREN_UPDATE_AVAILABLE_LABEL,
              IDS_VELMREN_UPDATE_AVAILABLE_TOOLTIP, true};
    case UpdatePhase::kDownloading:
      return {IDS_VELMREN_UPDATE_DOWNLOADING_LABEL,
              IDS_VELMREN_UPDATE_DOWNLOADING_TOOLTIP, true};
    case UpdatePhase::kInstalling:
      return {IDS_VELMREN_UPDATE_INSTALLING_LABEL,
              IDS_VELMREN_UPDATE_INSTALLING_TOOLTIP, true};
    case UpdatePhase::kReady:
      return {IDS_VELMREN_UPDATE_READY_LABEL,
              IDS_VELMREN_UPDATE_READY_TOOLTIP, true};
    case UpdatePhase::kUpToDate:
      return {IDS_VELMREN_UPDATE_UP_TO_DATE_LABEL,
              IDS_VELMREN_UPDATE_UP_TO_DATE_TOOLTIP, false};
    case UpdatePhase::kError:
      return {IDS_VELMREN_UPDATE_ERROR_LABEL,
              IDS_VELMREN_UPDATE_ERROR_TOOLTIP, false};
  }
  NOTREACHED();
}

}  // namespace velmren::delivery

#endif  // BRAVE_BROWSER_UI_TOOLBAR_VELMREN_UPDATE_MENU_H_
