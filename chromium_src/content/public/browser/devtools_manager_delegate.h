/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_CONTENT_PUBLIC_BROWSER_DEVTOOLS_MANAGER_DELEGATE_H_
#define BRAVE_CHROMIUM_SRC_CONTENT_PUBLIC_BROWSER_DEVTOOLS_MANAGER_DELEGATE_H_

// Keep browser-window ownership out of the content layer. A failed show must
// leave the unique_ptr untouched; a successful show transfers it to the UI.
#define SetActiveWebSocketConnections                                      \
  PrepareAgentTarget(WebContents* web_contents);                           \
  virtual void                                                            \
  ShowAgentTarget(std::unique_ptr<WebContents>& web_contents);             \
  virtual std::unique_ptr<WebContents> TakeAgentTarget(WebContents* source); \
  virtual void SetActiveWebSocketConnections

#include <content/public/browser/devtools_manager_delegate.h>  // IWYU pragma: export

#undef SetActiveWebSocketConnections

#endif  // BRAVE_CHROMIUM_SRC_CONTENT_PUBLIC_BROWSER_DEVTOOLS_MANAGER_DELEGATE_H_
