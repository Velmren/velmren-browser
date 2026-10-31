/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_CONTENT_BROWSER_DEVTOOLS_PROTOCOL_TARGET_HANDLER_H_
#define BRAVE_CHROMIUM_SRC_CONTENT_BROWSER_DEVTOOLS_PROTOCOL_TARGET_HANDLER_H_

#include "content/browser/devtools/protocol/target.h"

#define ActivateTarget                                                    \
  SetTargetVisibility(const std::string& target_id, bool visible) override; \
  Response ActivateTarget

#include <content/browser/devtools/protocol/target_handler.h>  // IWYU pragma: export

#undef ActivateTarget

#endif  // BRAVE_CHROMIUM_SRC_CONTENT_BROWSER_DEVTOOLS_PROTOCOL_TARGET_HANDLER_H_
