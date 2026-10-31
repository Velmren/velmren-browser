/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_CHROME_BROWSER_DEVTOOLS_CHROME_DEVTOOLS_MANAGER_DELEGATE_H_
#define BRAVE_CHROMIUM_SRC_CHROME_BROWSER_DEVTOOLS_CHROME_DEVTOOLS_MANAGER_DELEGATE_H_

#include "content/public/browser/devtools_manager_delegate.h"

#define UpdateDeviceDiscovery                                                 \
  PrepareAgentTarget(content::WebContents* web_contents) override;              \
  void                                                                         \
  ShowAgentTarget(std::unique_ptr<content::WebContents>& web_contents) override; \
  std::unique_ptr<content::WebContents> TakeAgentTarget(                        \
      content::WebContents* source) override;                                  \
  void UpdateDeviceDiscovery

#include <chrome/browser/devtools/chrome_devtools_manager_delegate.h>  // IWYU pragma: export

#undef UpdateDeviceDiscovery

#endif  // BRAVE_CHROMIUM_SRC_CHROME_BROWSER_DEVTOOLS_CHROME_DEVTOOLS_MANAGER_DELEGATE_H_
