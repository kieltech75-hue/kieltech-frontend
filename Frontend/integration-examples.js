(() => {
  const examples = [
    {
      id: 'curl',
      label: 'cURL',
      note: 'Use from a shell or server with cURL installed.',
      homeCode: String.raw`curl https://api.kieltech.com/v1/chat/completions \
  -H "Authorization: Bearer $KIELTECH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "YOUR_READY_MODEL_ID",
    "prompt": "Summarize this support request.",
    "stream": false
  }'`,
      code: String.raw`curl https://api.kieltech.com/v1/chat/completions \
  -H "Authorization: Bearer $KIELTECH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "YOUR_READY_MODEL_ID",
    "prompt": "Summarize the benefits of a reliable API.",
    "stream": false
  }'`
    },
    {
      id: 'python',
      label: 'Python',
      note: 'Install the HTTP client with python -m pip install requests.',
      code: String.raw`import os
import requests

response = requests.post(
    "https://api.kieltech.com/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {os.environ['KIELTECH_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "YOUR_READY_MODEL_ID",
        "prompt": "Summarize the benefits of a reliable API.",
        "stream": False,
    },
    timeout=60,
)
response.raise_for_status()
print(response.json())`
    },
    {
      id: 'javascript',
      label: 'JavaScript',
      note: 'For server-side JavaScript on Node.js 18 or later. Keep the key out of browser code.',
      code: String.raw`const apiKey = process.env.KIELTECH_API_KEY;
if (!apiKey) throw new Error("KIELTECH_API_KEY is required");

const response = await fetch(
  "https://api.kieltech.com/v1/chat/completions",
  {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "YOUR_READY_MODEL_ID",
      prompt: "Summarize the benefits of a reliable API.",
      stream: false,
    }),
  },
);
if (!response.ok) throw new Error(await response.text());
console.log(await response.json());`
    },
    {
      id: 'go',
      label: 'Go',
      note: 'Standard-library example for server-side Go services.',
      code: String.raw`package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
)

func main() {
	apiKey := os.Getenv("KIELTECH_API_KEY")
	if apiKey == "" {
		panic("KIELTECH_API_KEY is required")
	}
	body := []byte("{\"model\":\"YOUR_READY_MODEL_ID\",\"prompt\":\"Summarize the benefits of a reliable API.\",\"stream\":false}")
	req, err := http.NewRequest("POST", "https://api.kieltech.com/v1/chat/completions", bytes.NewReader(body))
	if err != nil { panic(err) }
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil { panic(err) }
	defer resp.Body.Close()
	result, err := io.ReadAll(resp.Body)
	if err != nil { panic(err) }
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		panic(fmt.Sprintf("KielTech API returned %s: %s", resp.Status, result))
	}
	fmt.Println(string(result))
}`
    },
    {
      id: 'java',
      label: 'Java',
      note: 'Uses the built-in HTTP client available in Java 11 and later.',
      code: String.raw`import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class KielTechExample {
  public static void main(String[] args) throws Exception {
    String apiKey = System.getenv("KIELTECH_API_KEY");
    if (apiKey == null || apiKey.isBlank()) {
      throw new IllegalStateException("KIELTECH_API_KEY is required");
    }
    String json = "{\"model\":\"YOUR_READY_MODEL_ID\",\"prompt\":\"Summarize the benefits of a reliable API.\",\"stream\":false}";
    HttpRequest request = HttpRequest.newBuilder()
        .uri(URI.create("https://api.kieltech.com/v1/chat/completions"))
        .header("Authorization", "Bearer " + apiKey)
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(json))
        .build();
    HttpResponse<String> response = HttpClient.newHttpClient()
        .send(request, HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() < 200 || response.statusCode() >= 300) {
      throw new IllegalStateException("KielTech API returned " + response.statusCode() + ": " + response.body());
    }
    System.out.println(response.body());
  }
}`
    },
    {
      id: 'kotlin',
      label: 'Kotlin',
      note: 'Uses Java 11 HttpClient from Kotlin/JVM; no additional HTTP dependency is needed.',
      code: String.raw`import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

fun main() {
    val apiKey = System.getenv("KIELTECH_API_KEY")
        ?: error("KIELTECH_API_KEY is required")
    val body = """{"model":"YOUR_READY_MODEL_ID","prompt":"Summarize the benefits of a reliable API.","stream":false}"""
    val request = HttpRequest.newBuilder()
        .uri(URI.create("https://api.kieltech.com/v1/chat/completions"))
        .header("Authorization", "Bearer $apiKey")
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .build()
    val response = HttpClient.newHttpClient()
        .send(request, HttpResponse.BodyHandlers.ofString())
    check(response.statusCode() in 200..299) {
        "KielTech API returned " + response.statusCode() + ": " + response.body()
    }
    println(response.body())
}`
    },
    {
      id: 'php',
      label: 'PHP',
      note: 'Requires PHP with the cURL extension enabled.',
      code: String.raw`<?php
$apiKey = getenv('KIELTECH_API_KEY');
if (!$apiKey) {
    throw new RuntimeException('KIELTECH_API_KEY is required');
}

$curl = curl_init('https://api.kieltech.com/v1/chat/completions');
curl_setopt_array($curl, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS => json_encode([
        'model' => 'YOUR_READY_MODEL_ID',
        'prompt' => 'Summarize the benefits of a reliable API.',
        'stream' => false,
    ], JSON_THROW_ON_ERROR),
]);
$response = curl_exec($curl);
if ($response === false) {
    throw new RuntimeException(curl_error($curl));
}
$status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
curl_close($curl);
if ($status < 200 || $status >= 300) {
    throw new RuntimeException("KielTech API returned HTTP $status: $response");
}
echo $response;`
    },
    {
      id: 'csharp',
      label: 'C# / .NET',
      note: 'Uses HttpClient and System.Text.Json available in modern .NET.',
      code: String.raw`using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

var apiKey = Environment.GetEnvironmentVariable("KIELTECH_API_KEY")
    ?? throw new InvalidOperationException("KIELTECH_API_KEY is required");
using var client = new HttpClient();
using var request = new HttpRequestMessage(
    HttpMethod.Post,
    "https://api.kieltech.com/v1/chat/completions"
);
request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
request.Content = new StringContent(
    JsonSerializer.Serialize(new {
        model = "YOUR_READY_MODEL_ID",
        prompt = "Summarize the benefits of a reliable API.",
        stream = false
    }),
    Encoding.UTF8,
    "application/json"
);
using var response = await client.SendAsync(request);
var body = await response.Content.ReadAsStringAsync();
response.EnsureSuccessStatusCode();
Console.WriteLine(body);`
    },
    {
      id: 'ruby',
      label: 'Ruby',
      note: 'Uses Ruby standard-library Net::HTTP and JSON.',
      code: String.raw`require "net/http"
require "json"
require "uri"

api_key = ENV.fetch("KIELTECH_API_KEY")
uri = URI("https://api.kieltech.com/v1/chat/completions")
request = Net::HTTP::Post.new(uri)
request["Authorization"] = "Bearer #{api_key}"
request["Content-Type"] = "application/json"
request.body = JSON.generate({
  model: "YOUR_READY_MODEL_ID",
  prompt: "Summarize the benefits of a reliable API.",
  stream: false
})

response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) do |http|
  http.request(request)
end
raise "KielTech API returned #{response.code}: #{response.body}" unless response.is_a?(Net::HTTPSuccess)
puts response.body`
    }
  ];

  window.KIELTECH_INTEGRATION_EXAMPLES = examples;
  let activeHomeExample = 0;
  let homeTimer = null;
  const homeCode = document.getElementById('homeIntegrationCode');
  const homeLabel = document.getElementById('homeExampleLanguage');
  const homeConsole = document.querySelector('.home-hero__console');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const stopHomeRotation = () => {
    window.clearTimeout(homeTimer);
    homeTimer = null;
  };

  const renderHomeExample = () => {
    if (!homeCode || !homeLabel) return;
    const example = examples[activeHomeExample];
    homeLabel.textContent = example.label;
    homeCode.textContent = example.homeCode || example.code;
  };

  const scheduleHomeRotation = () => {
    stopHomeRotation();
    if (!homeConsole || document.hidden || reducedMotion.matches) return;
    homeTimer = window.setTimeout(() => {
      activeHomeExample = (activeHomeExample + 1) % examples.length;
      renderHomeExample();
      scheduleHomeRotation();
    }, 3500);
  };

  document.addEventListener('visibilitychange', scheduleHomeRotation);
  reducedMotion.addEventListener?.('change', scheduleHomeRotation);
  renderHomeExample();
  scheduleHomeRotation();

  window.updateKieltechIntegrationModel = (modelId) => {
    examples.forEach((example) => {
      example.code = example.code.replaceAll('YOUR_READY_MODEL_ID', modelId);
      if (example.homeCode) example.homeCode = example.homeCode.replaceAll('YOUR_READY_MODEL_ID', modelId);
    });
    renderHomeExample();
  };

  const tabs = document.getElementById('integrationTabs');
  const panels = document.getElementById('integrationPanels');
  if (!tabs || !panels) return;

  examples.forEach((example, index) => {
    const tab = document.createElement('button');
    tab.id = `${example.id}Tab`;
    tab.className = 'integration-tab';
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(index === 0));
    tab.setAttribute('aria-controls', `${example.id}Panel`);
    tab.dataset.integrationTab = example.id;
    tab.tabIndex = index === 0 ? 0 : -1;
    tab.textContent = example.label;
    tabs.append(tab);

    const panel = document.createElement('section');
    panel.id = `${example.id}Panel`;
    panel.className = `integration-panel${index === 0 ? ' is-active' : ''}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.dataset.integrationPanel = example.id;
    panel.hidden = index !== 0;

    const code = document.createElement('code');
    code.textContent = example.code;
    const pre = document.createElement('pre');
    pre.className = 'integration-code';
    pre.append(code);
    const tip = document.createElement('p');
    tip.className = 'integration-tip';
    tip.textContent = example.note;
    panel.append(pre, tip);
    panels.append(panel);
  });

})();
