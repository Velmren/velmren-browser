/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "brave/browser/velmren_update_status.h"

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/json/json_writer.h"
#include "base/test/bind.h"
#include "base/values.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace velmren::delivery {
namespace {

class VelmrenUpdateStatusTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(root_.CreateUniqueTempDir());
    ASSERT_TRUE(base::Time::FromString("2026-11-08T00:00:00+00:00", &now_));
  }
  base::DictValue Snapshot(const char* phase) {
    return base::DictValue()
        .Set("schema", 1)
        .Set("phase", phase)
        .Set("installedVersion", "0.1.0.19")
        .Set("availableVersion", "0.1.0.20")
        .Set("updatedAt", "2026-11-08T00:00:00+00:00")
        .Set("lastCheckedAt", "2026-11-08T00:00:00+00:00");
  }
  void Write(const base::DictValue& value) {
    const auto json = base::WriteJson(value);
    ASSERT_TRUE(json);
    ASSERT_TRUE(base::WriteFile(
        root_.GetPath().AppendASCII("update-status.json"), *json));
  }
  UpdateStatus Read() {
    return ReadUpdateStatus(root_.GetPath(), "0.1.0.19", now_);
  }
  base::ScopedTempDir root_;
  base::Time now_;
};

TEST_F(VelmrenUpdateStatusTest, MissingMalformedAndOversizedAreUnknown) {
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
  ASSERT_TRUE(base::WriteFile(root_.GetPath().AppendASCII("update-status.json"),
                              "{broken"));
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
  ASSERT_TRUE(base::WriteFile(root_.GetPath().AppendASCII("update-status.json"),
                              std::string(17000, 'x')));
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
}

TEST_F(VelmrenUpdateStatusTest, LivePhasesDoNotPretendReady) {
  for (const auto* phase :
       {"checking", "available", "downloading", "installing", "error"}) {
    Write(Snapshot(phase));
    const auto status = Read();
    EXPECT_EQ(std::string(UpdatePhaseName(status.phase)), phase);
    EXPECT_NE(status.phase, UpdatePhase::kReady);
    EXPECT_EQ(status.installed_version, "0.1.0.19");
  }
}

TEST_F(VelmrenUpdateStatusTest, ReadyRequiresMatchingCommittedPending) {
  Write(Snapshot("ready"));
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
  ASSERT_TRUE(base::WriteFile(root_.GetPath().AppendASCII("pending.json"),
                              R"({"version":"0.1.0.21"})"));
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
  ASSERT_TRUE(base::WriteFile(root_.GetPath().AppendASCII("pending.json"),
                              R"({"version":"0.1.0.20"})"));
  EXPECT_EQ(Read().phase, UpdatePhase::kReady);
}

TEST_F(VelmrenUpdateStatusTest, WrongRunningVersionAndOldOffersAreUnknown) {
  auto value = Snapshot("available");
  value.Set("installedVersion", "0.1.0.18");
  Write(value);
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
  value.Set("installedVersion", "0.1.0.19");
  for (const auto* version :
       {"0.1.0.19", "0.1.0.18", "0.1.0.020", "0.1.0.2147483648", "invalid"}) {
    value.Set("availableVersion", version);
    Write(value);
    EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
  }
}

TEST_F(VelmrenUpdateStatusTest, InterruptedChecksAndOldSuccessfulChecksExpire) {
  Write(Snapshot("checking"));
  now_ += base::Minutes(31);
  EXPECT_EQ(Read().phase, UpdatePhase::kError);
  EXPECT_EQ(Read().error_code, "interrupted");
  Write(Snapshot("up-to-date"));
  EXPECT_EQ(Read().phase, UpdatePhase::kUpToDate);
  now_ += base::Hours(24);
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
}

TEST_F(VelmrenUpdateStatusTest, FutureAndUnknownSchemasDoNotClaimCurrent) {
  auto value = Snapshot("up-to-date");
  value.Set("schema", 2);
  Write(value);
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
  value.Set("schema", 1);
  value.Set("updatedAt", "2026-11-09T00:00:00Z");
  Write(value);
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
  value.Set("updatedAt", "2026-11-08T00:00:00Z");
  value.Set("lastCheckedAt", "2026-11-09T00:00:00Z");
  Write(value);
  EXPECT_EQ(Read().phase, UpdatePhase::kUnknown);
}

TEST_F(VelmrenUpdateStatusTest, ErrorDetailsStayBoundedPublicMetadata) {
  auto value = Snapshot("error");
  value.Set("errorCode", "private local path or raw server response");
  Write(value);
  EXPECT_EQ(Read().error_code, "check-failed");
  value.Set("errorCode", "activation-failed");
  Write(value);
  EXPECT_EQ(Read().error_code, "activation-failed");
}

TEST(VelmrenUpdateStatusMonitorTest, DeclinedRequestAcknowledgesCurrentState) {
  auto* monitor = UpdateStatusMonitor::GetInstance();
  ASSERT_FALSE(monitor->supported());
  int notifications = 0;
  auto subscription = monitor->AddObserver(
      base::BindLambdaForTesting([&] { ++notifications; }));
  monitor->CheckNow();
  EXPECT_EQ(notifications, 1);
}

}  // namespace
}  // namespace velmren::delivery
