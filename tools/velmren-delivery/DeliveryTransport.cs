using System.Net;
using System.Net.Http.Headers;

namespace Velmren.Delivery;

internal sealed class DeliveryTransport : IDisposable
{
    const int MaxRedirects = 5;
    readonly HttpClient client;

    internal DeliveryTransport(HttpMessageHandler? handler = null)
    {
        client = new HttpClient(handler ?? CreateHandler()) { Timeout = Timeout.InfiniteTimeSpan };
    }

    internal static HttpClientHandler CreateHandler() => new()
    {
        AllowAutoRedirect = false,
        UseProxy = false,
        UseCookies = false,
        UseDefaultCredentials = false,
        Credentials = null,
        PreAuthenticate = false,
        AutomaticDecompression = DecompressionMethods.None
        // Leave platform TLS protocol selection and certificate validation unchanged.
    };

    internal async Task<HttpResponseMessage> GetAsync(Uri uri, DeliveryPolicy policy, long? offset, CancellationToken cancellationToken)
    {
        for (var redirects = 0; ; redirects++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            policy.ValidateRequest(uri);
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            if (offset is > 0) request.Headers.Range = new RangeHeaderValue(offset, null);
            HttpResponseMessage response;
            try
            {
                response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            }
            catch (HttpRequestException error)
            {
                // Transport exceptions can contain a Location URI or its signed query.
                throw new HttpRequestException(error.HttpRequestError, "Update transport request failed.", statusCode: error.StatusCode);
            }
            if (!IsRedirect(response.StatusCode)) return response;
            using (response)
            {
                if (!policy.IsRelease) throw new InvalidDataException("Development feed redirects are not allowed.");
                if (redirects >= MaxRedirects) throw new InvalidDataException("Update redirect limit exceeded.");
                if (!response.Headers.TryGetValues("Location", out var locations))
                    throw new InvalidDataException("Update redirect has no Location.");
                var values = locations.ToArray();
                if (values.Length != 1) throw new InvalidDataException("Update redirect must have one Location.");
                var raw = values[0];
                if (raw != raw.Trim() || raw.Any(char.IsControl) || raw.Contains('\\')
                    || !Uri.TryCreate(uri, raw, out var next))
                    throw new InvalidDataException("Invalid update redirect URI.");
                policy.ValidateRequest(next);
                uri = next;
            }
        }
    }

    static bool IsRedirect(HttpStatusCode status) => (int)status is 301 or 302 or 303 or 307 or 308;

    internal static void EnsureSuccess(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Update server returned HTTP {(int)response.StatusCode}.", null, response.StatusCode);
    }

    public void Dispose() => client.Dispose();
}
