/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "content/public/browser/devtools_manager_delegate.h"

#include "content/public/browser/web_contents.h"

#include <content/public/browser/devtools_manager_delegate.cc>

namespace content {

void DevToolsManagerDelegate::PrepareAgentTarget(WebContents* web_contents) {}

// Embedders without a tab strip cannot perform agent handoff.
void DevToolsManagerDelegate::ShowAgentTarget(
    std::unique_ptr<WebContents>& web_contents) {}

std::unique_ptr<WebContents> DevToolsManagerDelegate::TakeAgentTarget(
    WebContents* source) {
  return nullptr;
}

}  // namespace content
