// Copyright (c) 2026 The Velmren Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

#include "brave/components/velmren/selection_translate_delegate.h"

#include <memory>
#include <string>
#include <string_view>
#include <utility>

#include "base/functional/bind.h"
#include "base/strings/utf_string_conversions.h"
#include "base/test/scoped_feature_list.h"
#include "base/test/task_environment.h"
#include "base/time/time.h"
#include "components/translate/content/browser/contextual_translate_delegate.h"
#include "components/translate/content/browser/partial_translate_manager.h"
#include "components/translate/core/common/translate_features.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/http/http_status_code.h"
#include "net/url_request/redirect_info.h"
#include "net/url_request/referrer_policy.h"
#include "services/network/public/cpp/data_element.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/cpp/weak_wrapper_shared_url_loader_factory.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "services/network/test/test_url_loader_factory.h"
#include "services/network/test/test_utils.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace velmren {
namespace {

constexpr char kAutoUrl[] =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto"
    "&tl=ru&dt=t&ie=UTF-8&oe=UTF-8";
constexpr char kManualUrl[] =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en"
    "&tl=ru&dt=t&ie=UTF-8&oe=UTF-8";
constexpr char kEnglishResponse[] =
    R"([[["Привет! ","Hello! "],["Спасибо.","Thank you."]],null,"en"])";

std::unique_ptr<ContextualSearchContext> MakeContext(
    const std::u16string& text = u"Hello! Thank you.") {
  auto context = std::make_unique<ContextualSearchContext>();
  context->SetRequestType(
      ContextualSearchContext::RequestType::PARTIAL_TRANSLATE);
  context->SetResolveProperties("", false);
  context->SetSelectionSurroundings(0, static_cast<int>(text.size()), text);
  context->SetTranslationLanguages("ru", "ru", "");
  context->SetApplyLangHint(true);
  return context;
}

class SelectionTranslateDelegateTest : public testing::Test {
 protected:
  void SetUp() override {
    delegate_ = std::make_unique<SelectionTranslateDelegate>(
        url_loader_factory_.GetSafeWeakWrapper());
  }

  void Start(ContextualSearchContext& context) {
    StartWeak(context.AsWeakPtr());
  }

  void StartWeak(base::WeakPtr<ContextualSearchContext> context) {
    delegate_->StartSearchTermResolutionRequest(
        context, nullptr,
        base::BindRepeating(&SelectionTranslateDelegateTest::OnResponse,
                            base::Unretained(this)));
    task_environment_.RunUntilIdle();
  }

  void Respond(std::string_view body,
               net::HttpStatusCode status = net::HTTP_OK,
               std::string_view url = kAutoUrl) {
    ASSERT_TRUE(url_loader_factory_.SimulateResponseForPendingRequest(url, body,
                                                                      status));
    task_environment_.RunUntilIdle();
  }

  const network::ResourceRequest* PendingRequest(
      std::string_view url = kAutoUrl) {
    const network::ResourceRequest* request = nullptr;
    EXPECT_TRUE(url_loader_factory_.IsPending(url, &request));
    return request;
  }

  std::string UploadBody(const network::ResourceRequest& request) {
    if (!request.request_body ||
        request.request_body->elements()->size() != 1u) {
      ADD_FAILURE() << "Expected one form-encoded upload body";
      return std::string();
    }
    const auto& element = request.request_body->elements()->front();
    if (element.type() != network::DataElement::Tag::kBytes) {
      ADD_FAILURE() << "Expected an in-memory selection upload";
      return std::string();
    }
    return std::string(element.As<network::DataElementBytes>().AsStringPiece());
  }

  void OnResponse(const ResolvedSearchTerm& response) {
    ++callback_count_;
    response_code_ = response.response_code;
    translated_text_ = response.caption;
    detected_language_ = response.context_language;
  }

  base::test::TaskEnvironment task_environment_{
      base::test::TaskEnvironment::TimeSource::MOCK_TIME};
  // Observe loader calls so redirect rejection can assert no FollowRedirect.
  network::TestURLLoaderFactory url_loader_factory_{true};
  std::unique_ptr<SelectionTranslateDelegate> delegate_;
  int callback_count_ = 0;
  int response_code_ = -1;
  std::string translated_text_;
  std::string detected_language_;
};

TEST_F(SelectionTranslateDelegateTest, DetectsSelectionDespiteRussianPageHint) {
  auto context = MakeContext();
  Start(*context);
  ASSERT_TRUE(PendingRequest());
  Respond(kEnglishResponse);
  EXPECT_EQ(callback_count_, 1);
  EXPECT_EQ(response_code_, net::HTTP_OK);
  EXPECT_EQ(detected_language_, "en");
  EXPECT_EQ(translated_text_, "Привет! Спасибо.");
}

TEST_F(SelectionTranslateDelegateTest, SendsOnlySelectionWithoutCredentials) {
  const std::u16string prefix = u"PRIVATE SURROUNDING CONTENT ";
  const std::u16string selection = u"Hello & goodbye";
  const std::u16string text = prefix + selection + u" PRIVATE SUFFIX";
  auto context = MakeContext(text);
  context->SetSelectionSurroundings(
      static_cast<int>(prefix.size()),
      static_cast<int>(prefix.size() + selection.size()), text);
  context->SetBasePageUrl(GURL("https://discord.com/channels/private/message"));
  Start(*context);
  const auto* request = PendingRequest();
  ASSERT_TRUE(request);
  EXPECT_EQ(request->url, GURL(kAutoUrl));
  EXPECT_EQ(request->method, "POST");
  EXPECT_EQ(request->credentials_mode, network::mojom::CredentialsMode::kOmit);
  EXPECT_EQ(request->redirect_mode, network::mojom::RedirectMode::kError);
  EXPECT_TRUE(request->referrer.is_empty());
  EXPECT_EQ(request->referrer_policy, net::ReferrerPolicy::NO_REFERRER);
  EXPECT_TRUE(request->site_for_cookies.IsNull());
  EXPECT_FALSE(request->request_initiator.has_value());
  EXPECT_NE(request->load_flags & net::LOAD_DISABLE_CACHE, 0);
  EXPECT_FALSE(request->headers.HasHeader("Cookie"));
  EXPECT_FALSE(request->headers.HasHeader("Referer"));
  EXPECT_FALSE(request->headers.HasHeader("Authorization"));
  EXPECT_FALSE(request->headers.HasHeader("X-Goog-Api-Key"));
  EXPECT_FALSE(request->headers.HasHeader("Origin"));
  EXPECT_EQ(request->headers.GetHeader("Content-Type"),
            "application/x-www-form-urlencoded; charset=UTF-8");
  EXPECT_EQ(UploadBody(*request), "q=Hello+%26+goodbye");
  Respond(kEnglishResponse);
}

TEST_F(SelectionTranslateDelegateTest, PreservesUnicodeNewlinesAndPlainText) {
  auto context = MakeContext(u"Hello 🌍\n<b>& +</b>");
  Start(*context);
  const auto* request = PendingRequest();
  ASSERT_TRUE(request);
  EXPECT_EQ(UploadBody(*request),
            "q=Hello+%F0%9F%8C%8D%0A%3Cb%3E%26+%2B%3C/b%3E");
  Respond(R"([[["Привет 🌍\n"],["<b>& +</b>"]],null,"en"])");
  EXPECT_EQ(response_code_, net::HTTP_OK);
  EXPECT_EQ(base::UTF8ToUTF16(translated_text_), u"Привет 🌍\n<b>& +</b>");
}

TEST_F(SelectionTranslateDelegateTest,
       HonorsExplicitSourceAfterInitialRequest) {
  auto context = MakeContext();
  context->SetApplyLangHint(false);
  context->SetTranslationLanguages("en", "ru", "");
  Start(*context);
  ASSERT_TRUE(PendingRequest(kManualUrl));
  // An explicit source remains usable when the service omits detection.
  Respond(R"([[["Привет! Спасибо."]]])", net::HTTP_OK, kManualUrl);
  EXPECT_EQ(response_code_, net::HTTP_OK);
  EXPECT_EQ(detected_language_, "en");
}

TEST_F(SelectionTranslateDelegateTest, UnknownSourceUsesAutoDetection) {
  auto context = MakeContext();
  context->SetApplyLangHint(false);
  context->SetTranslationLanguages("und", "ru", "");
  Start(*context);
  ASSERT_TRUE(PendingRequest());
  Respond(kEnglishResponse);
  EXPECT_EQ(detected_language_, "en");
}

TEST_F(SelectionTranslateDelegateTest, SameTargetLanguageIsSuccessful) {
  auto context = MakeContext(u"Привет");
  Start(*context);
  Respond(R"([[["Привет","Привет"]],null,"ru"])");
  EXPECT_EQ(response_code_, net::HTTP_OK);
  EXPECT_EQ(translated_text_, "Привет");
  EXPECT_EQ(detected_language_, "ru");
}

TEST_F(SelectionTranslateDelegateTest, MalformedOrIncompleteResponsesFail) {
  const char* invalid_responses[] = {"",
                                     "not JSON",
                                     "{}",
                                     "[]",
                                     "[null,null,\"en\"]",
                                     "[[],null,\"en\"]",
                                     "[[[]],null,\"en\"]",
                                     "[[[42]],null,\"en\"]",
                                     "[[[\"ok\"],null],null,\"en\"]",
                                     "[[[\"\"]],null,\"en\"]",
                                     "[[[\"ok\"]],null]",
                                     "[[[\"ok\"]],null,\"und\"]",
                                     "[[[\"ok\"]],null,42]",
                                     "[[[\"ok\"]],null,\"en&key=bad\"]"};
  for (const auto* body : invalid_responses) {
    SCOPED_TRACE(body);
    auto context = MakeContext();
    const int prior_callback_count = callback_count_;
    Start(*context);
    Respond(body);
    EXPECT_EQ(callback_count_, prior_callback_count + 1);
    EXPECT_NE(response_code_, net::HTTP_OK);
    EXPECT_TRUE(translated_text_.empty());
  }
}

TEST_F(SelectionTranslateDelegateTest, HttpFailuresDoNotRetry) {
  for (auto status : {net::HTTP_FORBIDDEN, net::HTTP_TOO_MANY_REQUESTS,
                      net::HTTP_INTERNAL_SERVER_ERROR}) {
    auto context = MakeContext();
    Start(*context);
    Respond("Forbidden", status);
    EXPECT_EQ(response_code_, status);
  }
  task_environment_.FastForwardBy(base::Minutes(1));
  EXPECT_EQ(url_loader_factory_.total_requests(), 3u);
  EXPECT_EQ(callback_count_, 3);
}

TEST_F(SelectionTranslateDelegateTest, NetworkFailureDoesNotRetry) {
  auto context = MakeContext();
  Start(*context);
  ASSERT_TRUE(url_loader_factory_.SimulateResponseForPendingRequest(
      GURL(kAutoUrl),
      network::URLLoaderCompletionStatus(net::ERR_INTERNET_DISCONNECTED),
      nullptr, ""));
  task_environment_.RunUntilIdle();
  EXPECT_EQ(callback_count_, 1);
  EXPECT_NE(response_code_, net::HTTP_OK);
  task_environment_.FastForwardBy(base::Minutes(1));
  EXPECT_EQ(url_loader_factory_.total_requests(), 1u);
}

TEST_F(SelectionTranslateDelegateTest, TimeoutCompletesOnceWithoutRetry) {
  auto context = MakeContext();
  Start(*context);
  task_environment_.FastForwardBy(base::Seconds(19));
  EXPECT_EQ(callback_count_, 0);
  task_environment_.FastForwardBy(base::Seconds(2));
  EXPECT_EQ(callback_count_, 1);
  EXPECT_NE(response_code_, net::HTTP_OK);
  task_environment_.FastForwardBy(base::Minutes(1));
  EXPECT_EQ(callback_count_, 1);
  EXPECT_EQ(url_loader_factory_.total_requests(), 1u);
}

TEST_F(SelectionTranslateDelegateTest, ResponseSizeIsBounded) {
  auto context = MakeContext();
  Start(*context);
  const std::string response =
      "[[[\"" + std::string(300 * 1024, 'a') + "\"]],null,\"en\"]";
  Respond(response);
  EXPECT_EQ(callback_count_, 1);
  EXPECT_NE(response_code_, net::HTTP_OK);
}

TEST_F(SelectionTranslateDelegateTest, RedirectDoesNotForwardSelection) {
  auto context = MakeContext();
  Start(*context);
  auto* pending = url_loader_factory_.GetPendingRequest(0);
  ASSERT_TRUE(pending);
  net::RedirectInfo redirect;
  redirect.status_code = 307;
  redirect.new_url = GURL("https://example.invalid/redirect");
  pending->client->OnReceiveRedirect(
      redirect, network::CreateURLResponseHead(net::HTTP_TEMPORARY_REDIRECT));
  task_environment_.RunUntilIdle();
  EXPECT_EQ(callback_count_, 1);
  EXPECT_NE(response_code_, net::HTTP_OK);
  EXPECT_TRUE(pending->test_url_loader->follow_redirect_params().empty());
  EXPECT_EQ(url_loader_factory_.total_requests(), 1u);
}

TEST_F(SelectionTranslateDelegateTest, NewRequestCancelsPreviousCallback) {
  auto first = MakeContext(u"First message");
  Start(*first);
  auto second = MakeContext(u"Second message");
  Start(*second);
  EXPECT_EQ(url_loader_factory_.total_requests(), 2u);
  EXPECT_EQ(url_loader_factory_.NumPending(), 1);
  Respond(kEnglishResponse);
  EXPECT_EQ(callback_count_, 1);
  EXPECT_EQ(response_code_, net::HTTP_OK);
  task_environment_.FastForwardBy(base::Minutes(1));
  EXPECT_EQ(callback_count_, 1);
}

TEST_F(SelectionTranslateDelegateTest, DestructionCancelsRequest) {
  auto context = MakeContext();
  Start(*context);
  delegate_.reset();
  task_environment_.RunUntilIdle();
  EXPECT_EQ(url_loader_factory_.NumPending(), 0);
  task_environment_.FastForwardBy(base::Minutes(1));
  EXPECT_EQ(callback_count_, 0);
}

TEST_F(SelectionTranslateDelegateTest, CallbackCanDestroyDelegate) {
  auto context = MakeContext();
  delegate_->StartSearchTermResolutionRequest(
      context->AsWeakPtr(), nullptr,
      base::BindRepeating(
          [](std::unique_ptr<SelectionTranslateDelegate>* owner, int* count,
             int* code, const ResolvedSearchTerm& response) {
            ++*count;
            *code = response.response_code;
            owner->reset();
          },
          &delegate_, &callback_count_, &response_code_));
  task_environment_.RunUntilIdle();
  Respond(kEnglishResponse);
  EXPECT_FALSE(delegate_);
  EXPECT_EQ(callback_count_, 1);
  EXPECT_EQ(response_code_, net::HTTP_OK);
}

TEST_F(SelectionTranslateDelegateTest, InvalidSelectionsNeverSendRequests) {
  for (const std::u16string& text :
       {std::u16string(), std::u16string(u" \n\t "),
        std::u16string(501, u'a')}) {
    auto context = MakeContext(text);
    Start(*context);
    EXPECT_NE(response_code_, net::HTTP_OK);
  }
  auto context = MakeContext();
  context->SetSelectionSurroundings(-1, 2, u"abc");
  Start(*context);
  context->SetSelectionSurroundings(0, 4, u"abc");
  Start(*context);
  context->SetSelectionSurroundings(2, 1, u"abc");
  Start(*context);
  EXPECT_EQ(url_loader_factory_.total_requests(), 0u);
  EXPECT_EQ(callback_count_, 6);
}

TEST_F(SelectionTranslateDelegateTest, NativeMaximumSelectionIsAccepted) {
  auto context = MakeContext(std::u16string(500, u'a'));
  Start(*context);
  ASSERT_TRUE(PendingRequest());
  Respond(kEnglishResponse);
  EXPECT_EQ(response_code_, net::HTTP_OK);
}

TEST_F(SelectionTranslateDelegateTest, WrongContextOrInvalidTargetNeverSends) {
  auto context = MakeContext();
  context->SetRequestType(
      ContextualSearchContext::RequestType::CONTEXTUAL_SEARCH);
  Start(*context);
  context->SetRequestType(
      ContextualSearchContext::RequestType::PARTIAL_TRANSLATE);
  for (const auto* target :
       {"", "auto", "und", "ru&q=private", "-ru", "ru--RU"}) {
    context->SetTranslationLanguages("ru", target, "");
    Start(*context);
  }
  EXPECT_EQ(url_loader_factory_.total_requests(), 0u);
  EXPECT_EQ(callback_count_, 7);
}

TEST_F(SelectionTranslateDelegateTest, ExpiredContextFailsWithoutRequest) {
  auto context = MakeContext();
  auto weak_context = context->AsWeakPtr();
  context.reset();
  StartWeak(weak_context);
  EXPECT_EQ(callback_count_, 1);
  EXPECT_NE(response_code_, net::HTTP_OK);
  EXPECT_EQ(url_loader_factory_.total_requests(), 0u);
}

TEST_F(SelectionTranslateDelegateTest, GatherNeverReadsAdditionalPageContent) {
  auto context = MakeContext(u"private Hello private");
  context->SetSelectionSurroundings(8, 13, u"private Hello private");
  bool called = false;
  delegate_->GatherAndSaveSurroundingText(
      context->AsWeakPtr(), nullptr,
      base::BindRepeating(
          [](bool* called, const std::string&, const std::u16string& selection,
             size_t start, size_t end) {
            *called = true;
            EXPECT_EQ(selection, u"Hello");
            EXPECT_EQ(start, 0u);
            EXPECT_EQ(end, 5u);
          },
          &called));
  EXPECT_TRUE(called);
  EXPECT_EQ(url_loader_factory_.total_requests(), 0u);
}

TEST_F(SelectionTranslateDelegateTest, NativeManagerIgnoresOnePlatformFlag) {
  base::test::ScopedFeatureList features;
  features.InitAndEnableFeature(translate::kPartialTranslateUseOnePlatformApi);
  // Match the controller's injected construction, including the null alternate.
  PartialTranslateManager manager(std::move(delegate_), nullptr);
  PartialTranslateRequest request;
  request.selection_text = u"Hello! Thank you.";
  request.source_language = "ru";
  request.target_language = "ru";
  request.apply_lang_hint = true;
  bool completed = false;
  manager.StartPartialTranslate(
      nullptr, request,
      base::BindOnce(
          [](bool* completed, const PartialTranslateResponse& response) {
            *completed = true;
            EXPECT_EQ(response.status, PartialTranslateStatus::kSuccess);
            EXPECT_EQ(response.translated_text, u"Привет! Спасибо.");
            EXPECT_EQ(response.source_language, "en");
            EXPECT_EQ(response.target_language, "ru");
          },
          &completed));
  task_environment_.RunUntilIdle();
  ASSERT_TRUE(PendingRequest());
  Respond(kEnglishResponse);
  EXPECT_TRUE(completed);
  EXPECT_EQ(url_loader_factory_.total_requests(), 1u);
}

}  // namespace
}  // namespace velmren
