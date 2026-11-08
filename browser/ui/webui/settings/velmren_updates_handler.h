/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_BROWSER_UI_WEBUI_SETTINGS_VELMREN_UPDATES_HANDLER_H_
#define BRAVE_BROWSER_UI_WEBUI_SETTINGS_VELMREN_UPDATES_HANDLER_H_

#include "base/callback_list.h"
#include "chrome/browser/ui/webui/settings/settings_page_ui_handler.h"

class VelmrenUpdatesHandler : public settings::SettingsPageUIHandler {
 public:
  VelmrenUpdatesHandler();
  ~VelmrenUpdatesHandler() override;

 private:
  void RegisterMessages() override;
  void OnJavascriptAllowed() override;
  void OnJavascriptDisallowed() override;
  void GetStatus(const base::ListValue& args);
  void CheckNow(const base::ListValue& args);
  void Relaunch(const base::ListValue& args);
  void OnStatusChanged();
  base::CallbackListSubscription subscription_;
};

#endif  // BRAVE_BROWSER_UI_WEBUI_SETTINGS_VELMREN_UPDATES_HANDLER_H_
