// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#ifndef BRAVE_COMPONENTS_VELMREN_PRODUCT_POLICY_H_
#define BRAVE_COMPONENTS_VELMREN_PRODUCT_POLICY_H_

namespace velmren {

// Product boundaries, not runtime experiments: imported preferences and remote
// feature configurations must not enable these services in Velmren.
inline constexpr bool kTelemetryEnabled = false;
inline constexpr bool kProductPromotionsEnabled = false;
inline constexpr bool kSponsoredContentEnabled = false;
inline constexpr bool kRemoteExperimentsEnabled = false;

}  // namespace velmren

#endif  // BRAVE_COMPONENTS_VELMREN_PRODUCT_POLICY_H_
