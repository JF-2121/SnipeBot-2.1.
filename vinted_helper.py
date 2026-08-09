#!/usr/bin/env python3
"""
Vinted scraper helper for Node.js bot.
Extracts data from _R_ script tag (Vinted's current data container).
Fallback: Direct HTML extraction from product anchors.
Returns JSON to stdout for Node subprocess consumption.
"""

import asyncio
import html
import json
import re
import sys
import urllib.parse
import aiohttp
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

VINTED_BASE_URL = "https://www.vinted.de/catalog"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

def _parse_price_text(text: str):
    """Extract a float price from mixed localized text."""
    cleaned = html.unescape(str(text)).strip().replace("\xa0", " ")
    match = re.search(r"(-?\d[\d.\s]*(?:[,.]\d{1,2})?)", cleaned)
    if not match:
        return None
    raw = match.group(1).replace(" ", "")

    if "," in raw and "." in raw:
        if raw.rfind(",") > raw.rfind("."):
            raw = raw.replace(".", "").replace(",", ".")
        else:
            raw = raw.replace(",", "")
    elif "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    else:
        if raw.count(".") > 1:
            parts = raw.split(".")
            raw = "".join(parts[:-1]) + "." + parts[-1]

    try:
        return float(raw)
    except ValueError:
        return None


def _to_float(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return _parse_price_text(value)
    return None


def _first_non_empty(*values):
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and value.strip() == "":
            continue
        return value
    return None


def _dict_get(obj, *keys):
    if not isinstance(obj, dict):
        return None
    for key in keys:
        if key in obj:
            return obj[key]
    return None


def _extract_first_photo_urls(item_data):
    photos = item_data.get("photos", []) if isinstance(item_data, dict) else []
    photo_urls = []
    for photo in photos:
        if not isinstance(photo, dict):
            continue
        thumbs = photo.get("thumbnails", [])
        thumb_url = ""
        if isinstance(thumbs, list):
            for thumb in thumbs:
                if not isinstance(thumb, dict):
                    continue
                if thumb.get("type") in ("thumb310x430", "thumb310x430_2x"):
                    thumb_url = thumb.get("url", "")
                    break
        url = _first_non_empty(
            thumb_url,
            photo.get("full_size_url"),
            photo.get("url"),
        )
        if url:
            photo_urls.append(str(url))
    return photo_urls


def _collect_catalog_items(node, out):
    if isinstance(node, dict):
        catalog_items = node.get("catalogItems")
        if isinstance(catalog_items, list):
            out.extend([x for x in catalog_items if isinstance(x, dict)])
        items = node.get("items")
        if isinstance(items, list):
            if any(isinstance(x, dict) and ("id" in x or "title" in x) for x in items):
                out.extend([x for x in items if isinstance(x, dict)])
        for value in node.values():
            _collect_catalog_items(value, out)
    elif isinstance(node, list):
        for value in node:
            _collect_catalog_items(value, out)


def _parse_json_listing(item_data, listing_id, search_text):
    price_obj = _dict_get(item_data, "price") or {}
    if not isinstance(price_obj, dict):
        price_obj = {}
    status_obj = _dict_get(item_data, "status") or {}
    if not isinstance(status_obj, dict):
        status_obj = {}
    size_obj = _dict_get(item_data, "size") or {}
    if not isinstance(size_obj, dict):
        size_obj = {}
    user_obj = _dict_get(item_data, "user") or {}
    if not isinstance(user_obj, dict):
        user_obj = {}

    base_price = _first_non_empty(
        _to_float(price_obj.get("amount")),
        _to_float(price_obj.get("numeric")),
        _to_float(item_data.get("price_numeric")),
        _to_float(item_data.get("price")),
    )

    buyer_protection_fee = _first_non_empty(
        _to_float(item_data.get("buyer_protection_fee")),
        _to_float(item_data.get("service_fee")),
        _to_float(item_data.get("service_fee_amount")),
        _to_float(item_data.get("buyer_fee")),
        _to_float(price_obj.get("service_fee")),
        _to_float(price_obj.get("buyer_protection_fee")),
    )
    shipping_fee = _first_non_empty(
        _to_float(item_data.get("shipping_fee")),
        _to_float(item_data.get("shipping_price")),
        _to_float(item_data.get("delivery_fee")),
        _to_float(price_obj.get("shipping_fee")),
        _to_float(price_obj.get("shipping_price")),
    )

    total_price = _first_non_empty(
        _to_float(item_data.get("total_item_price")),
        _to_float(item_data.get("total_price")),
        _to_float(price_obj.get("total_amount")),
    )

    if total_price is not None and base_price is not None:
        derived_fee = total_price - base_price
        if buyer_protection_fee is None and shipping_fee is None and derived_fee > 0:
            buyer_protection_fee = derived_fee

    fee_total = (buyer_protection_fee or 0.0) + (shipping_fee or 0.0)
    if total_price is None and base_price is not None:
        total_price = base_price + fee_total

    title = str(item_data.get("title") or f"Item {listing_id}")
    description = str(item_data.get("description") or "").strip()
    brand = str(
        _first_non_empty(
            item_data.get("brand_title"),
            _dict_get(item_data.get("brand"), "title") if isinstance(item_data.get("brand"), dict) else None,
            search_text.split()[0] if search_text else "Unknown",
        )
    )
    link = str(item_data.get("url") or f"/items/{listing_id}")
    photos = _extract_first_photo_urls(item_data)
    image_url = photos[0] if photos else ""

    seller_username = str(
        _first_non_empty(
            user_obj.get("login"),
            user_obj.get("username"),
            user_obj.get("name"),
            "",
        )
    )
    user_photo = user_obj.get("photo")
    seller_avatar = ""
    if isinstance(user_photo, dict):
        seller_avatar = str(
            _first_non_empty(
                user_photo.get("url"),
                user_photo.get("full_size_url"),
                "",
            )
        )
    else:
        seller_avatar = str(_first_non_empty(user_obj.get("avatar_url"), user_obj.get("photo_url"), ""))

    review_count_raw = _first_non_empty(
        user_obj.get("positive_feedback_count"),
        user_obj.get("feedback_count"),
        user_obj.get("reviews_count"),
        0,
    )
    review_count = int(_to_float(review_count_raw) or 0)
    review_rating = _to_float(user_obj.get("feedback_reputation"))

    published_at = _first_non_empty(
        item_data.get("created_at_ts"),
        item_data.get("photo_updated_at"),
        item_data.get("created_at"),
        "",
    )

    condition = str(
        _first_non_empty(
            status_obj.get("title"),
            status_obj.get("value"),
            item_data.get("status"),
            item_data.get("condition_title"),
            "",
        )
    )
    size = str(_first_non_empty(size_obj.get("title"), item_data.get("size_title"), item_data.get("size"), ""))
    country_title = str(
        _first_non_empty(
            item_data.get("country_title"),
            user_obj.get("country_title"),
            "Germany",
        )
    )

    # Produce a clean title (remove obvious size/condition/price snippets)
    def _clean_title(t: str) -> str:
        s = re.sub(r"\s*\(.*?(?:Größe|Size|size|größe).*?\)", "", t, flags=re.IGNORECASE)
        s = re.sub(r"\s*[-|]\s*\d+[\d.,\s]*€", "", s)
        s = re.sub(r"\s*\d+[\d.,\s]*€", "", s)
        s = re.sub(r"\s*\|\s*.*$", "", s)
        return s.strip()

    clean_title = _clean_title(title)
    images_array = photos[:3]
    base_price_val = float(base_price) if base_price is not None else None
    protection_fee_val = float((buyer_protection_fee or 0.0) + (shipping_fee or 0.0))

    return {
        "id": listing_id,
        "title": title,
        "cleanTitle": clean_title,
        "description": description,
        "base_price": base_price_val,
        "protection_fee": protection_fee_val,
        "feeTotal": float(fee_total),
        "totalPrice": float(total_price) if total_price is not None else None,
        "size": size,
        "brand": brand,
        "link": link if link.startswith("http") else f"https://www.vinted.de{link}",
        "imageUrl": image_url,
        "main_image_url": image_url,
        "photos": photos,
        "images_array": images_array,
        "condition": condition,
        "publishedAt": str(published_at or ""),
        "countryTitle": country_title,
        "reviewCount": review_count,
        "reviewRating": float(review_rating) if review_rating is not None else None,
        "sellerUsername": seller_username,
        "sellerAvatar": seller_avatar,
        "platform": "vinted",
    }

def extract_from_anchor_html(html_text: str, listing_id: str, anchor_start: int, anchor_end: int, search_text: str):
    """
    Extract data directly from HTML anchor and surrounding context.
    This is the FALLBACK when JSON is not available.
    """
    # Get window around the anchor
    window_start = max(0, anchor_start - 2000)
    window_end = min(len(html_text), anchor_end + 2000)
    window = html_text[window_start:window_end]
    
    # Extract title from anchor title attribute
    title_match = re.search(r'title="([^"]+)"', window, re.IGNORECASE)
    title = html.unescape(title_match.group(1)) if title_match else f"Item {listing_id}"
    
    # Extract price from title/window
    price = _parse_price_text(title)
    if price is None:
        price = _parse_price_text(window)
    
    # Extract URL
    href_match = re.search(r'href="([^"]+)"', window, re.IGNORECASE)
    url = html.unescape(href_match.group(1)) if href_match else f"/items/{listing_id}"
    
    # Extract image
    image_match = re.search(
        rf'<img[^>]+data-testid="product-item-id-{listing_id}--image--img"[^>]*src="([^"]+)"',
        window,
        re.IGNORECASE,
    ) or re.search(
        rf'<img[^>]*src="([^"]+)"[^>]+data-testid="product-item-id-{listing_id}--image--img"',
        window,
        re.IGNORECASE,
    )
    image_url = html.unescape(image_match.group(1)) if image_match else ""
    
    # Extract seller username/avatar if present in nearby payload
    seller_username_match = re.search(r'"login"\s*:\s*"([^"]+)"', window, re.IGNORECASE)
    seller_avatar_match = re.search(r'"(?:avatar_url|photo_url)"\s*:\s*"([^"]+)"', window, re.IGNORECASE)
    seller_username = html.unescape(seller_username_match.group(1)) if seller_username_match else ""
    seller_avatar = html.unescape(seller_avatar_match.group(1)) if seller_avatar_match else ""

    # Extract metadata from nearby raw HTML where possible
    size_match = re.search(r'(?:size|größe)\s*[:\-]?\s*([A-Za-z0-9/.\-]+)', window, re.IGNORECASE)
    condition_match = re.search(r'(?:condition|zustand)\s*[:\-]?\s*([A-Za-z0-9äöüÄÖÜß\s\-]+)', window, re.IGNORECASE)
    published_match = re.search(r'(?:vor\s+\d+\s+(?:Min\.?|Std\.?|Tagen?|Wochen?|Monaten?)|\d{1,2}\.\d{1,2}\.\d{2,4})', window, re.IGNORECASE)

    # Extract brand from search text
    brand = search_text.split()[0] if search_text else "Unknown"
    
    # Fallback cleaned title
    def _clean_title(t: str) -> str:
        s = re.sub(r"\s*\(.*?(?:Größe|Size|size|größe).*?\)", "", t, flags=re.IGNORECASE)
        s = re.sub(r"\s*[-|]\s*\d+[\d.,\s]*€", "", s)
        s = re.sub(r"\s*\d+[\d.,\s]*€", "", s)
        s = re.sub(r"\s*\|\s*.*$", "", s)
        return s.strip()

    clean_title = _clean_title(title)
    images_array = [image_url] if image_url else []
    base_price_val = float(price) if price is not None else None
    protection_fee_val = 0.0

    return {
        'id': listing_id,
        'title': title,
        'cleanTitle': clean_title,
        'description': '',
        'base_price': base_price_val,
        'protection_fee': protection_fee_val,
        'feeTotal': 0.0,
        'totalPrice': float(price) if price is not None else None,
        'size': html.unescape(size_match.group(1)).strip() if size_match else "",
        'brand': brand,
        'link': url if url.startswith('http') else f"https://www.vinted.de{url}",
        'imageUrl': image_url,
        'main_image_url': image_url,
        'photos': [image_url] if image_url else [],
        'images_array': images_array,
        'condition': html.unescape(condition_match.group(1)).strip() if condition_match else "",
        'publishedAt': html.unescape(published_match.group(0)).strip() if published_match else "",
        'countryTitle': 'Germany',
        'reviewCount': 0,
        'reviewRating': None,
        'sellerUsername': seller_username,
        'sellerAvatar': seller_avatar,
        'platform': 'vinted'
    }

def parse_listings(html_text: str, search_text: str):
    """
    Parse Vinted catalog HTML from _R_ script tag or fallback to direct HTML extraction.
    """
    
    listings = []
    seen_ids = set()
    json_items = {}
    
    # Extract JSON data from _R_ script tag
    r_tag_match = re.search(
        r'<script id="_R_" type="application/json">(.+?)</script>',
        html_text,
        re.DOTALL
    )
    
    if r_tag_match:
        try:
            r_data = json.loads(r_tag_match.group(1))
            catalog_items = []
            _collect_catalog_items(r_data, catalog_items)

            for item in catalog_items:
                item_id = str(item.get('id', ''))
                if item_id:
                    json_items[item_id] = item
                    
        except (json.JSONDecodeError, KeyError):
            pass
    
    # Find all product anchors
    anchor_pattern = re.compile(
        r'<a[^>]*data-testid="product-item-id-(?P<id>\d+)--overlay-link"[^>]*>',
        re.IGNORECASE,
    )

    matches = list(anchor_pattern.finditer(html_text))
    if not matches:
        return listings

    for match in matches:
        listing_id = match.group("id")
        
        if listing_id in seen_ids:
            continue
        
        seen_ids.add(listing_id)
        
        # Try JSON first, fallback to HTML extraction
        if listing_id in json_items:
            item_data = json_items[listing_id]
            item = _parse_json_listing(item_data, listing_id, search_text)
            if item.get("price") and float(item["price"]) > 0:
                listings.append(item)
        else:
            # Fallback: Extract from HTML
            item = extract_from_anchor_html(html_text, listing_id, match.start(), match.end(), search_text)
            if item.get("price") and float(item["price"]) > 0:
                listings.append(item)

    return listings

async def main():
    """Main entry point for subprocess calls from Node.js"""
    if len(sys.argv) < 2:
        result = {"success": False, "error": "Usage: vinted_helper.py <search_text> [max_price]", "items": []}
        print(json.dumps(result), flush=True)
        sys.exit(1)
    
    search_text = sys.argv[1]
    max_price = None
    
    if len(sys.argv) > 2:
        try:
            max_price = float(sys.argv[2])
        except ValueError:
            pass
    
    params = {
        "search_text": search_text,
        "order": "newest_first",
    }
    if max_price and max_price > 0:
        params["price_to"] = str(int(max_price))
    
    url = f"{VINTED_BASE_URL}?{urllib.parse.urlencode(params)}"
    headers = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9"
    }
    
    try:
        # Use existing aiohttp.ClientSession but enhance headers, cookie handling and error reporting
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15.0)) as session:
            # Strong macOS Chrome-like headers for homepage visit
            ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            homepage_headers = {
                "User-Agent": ua,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-origin",
                "Sec-Ch-Ua": '"Chromium";v="122", "Google Chrome";v="122", ";Not A Brand";v="99"',
                "Sec-Ch-Ua-Platform": '"macOS"',
                "Upgrade-Insecure-Requests": "1",
                "Referer": "https://www.vinted.de/",
            }

            # Retry homepage fetch until session cookie appears (max retries)
            max_retries = 6
            got_cookie = False
            for attempt in range(1, max_retries + 1):
                try:
                    async with session.get("https://www.vinted.de/", headers=homepage_headers, allow_redirects=True) as home_res:
                        home_text = await home_res.text()
                        cookie_snapshot = {c.key: c.value for c in session.cookie_jar}
                        # New cookie validation: accept modern cookie names returned by Vinted
                        if any(k in ["access_token_web", "anon_id", "v_udt"] for k in cookie_snapshot.keys()):
                            got_cookie = True
                            break
                except Exception:
                    # small backoff and retry
                    await asyncio.sleep(1)
                    continue
                await asyncio.sleep(1)

            cookie_snapshot = {c.key: c.value for c in session.cookie_jar}
            if not got_cookie:
                # MUST NOT silently return success; print diagnostic JSON
                print(json.dumps({"success": False, "error": "NO_SESSION_COOKIE", "cookies": list(cookie_snapshot.keys())}), flush=True)
                return

            # API headers to mimic a real browser fetch for the JSON endpoint
            api_headers = {
                "User-Agent": ua,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-site",
                "Sec-Ch-Ua": '"Chromium";v="122", "Google Chrome";v="122", ";Not A Brand";v="99"',
                "Sec-Ch-Ua-Mobile": "?0",
                "Sec-Ch-Ua-Platform": '"macOS"',
                "Referer": "https://www.vinted.de/",
                "X-Requested-With": "XMLHttpRequest",
            }

            # Explicit cookie header (session will normally include cookies, but add header to be explicit)
            cookie_header = "; ".join([f"{k}={v}" for k, v in cookie_snapshot.items()])
            if cookie_header:
                api_headers["Cookie"] = cookie_header

            params_api = {"search_text": search_text, "order": "newest_first"}
            if max_price and max_price > 0:
                params_api["price_to"] = str(int(max_price))

            try:
                async with session.get("https://www.vinted.de/api/v2/catalog/items", headers=api_headers, params=params_api) as api_res:
                    status = api_res.status
                    text = await api_res.text()

                    if status != 200:
                        # MUST print raw status and first 500 chars to stdout for debugging WAF
                        snippet = text[:500].replace("\n", " ")
                        print(json.dumps({"success": False, "error": "API_HTTP_ERROR", "status": status, "body_snippet": snippet}), flush=True)
                        return

                    # Parse JSON or report decode failure with response snippet
                    try:
                        data = json.loads(text)
                    except Exception as e_json:
                        snippet = text[:500].replace("\n", " ")
                        print(json.dumps({"success": False, "error": "API_JSON_DECODE", "exception": str(e_json), "body_snippet": snippet}), flush=True)
                        return

                    catalog_items = []
                    _collect_catalog_items(data, catalog_items)

                    listings = []
                    for item_data in catalog_items:
                        item_id = str(item_data.get('id', ''))
                        if not item_id:
                            continue
                        parsed = _parse_json_listing(item_data, item_id, search_text)
                        if parsed.get("totalPrice") is None:
                            parsed["totalPrice"] = parsed.get("base_price") or parsed.get("price") or 0.0
                        if parsed.get("price") is None:
                            parsed["price"] = parsed.get("base_price") or parsed.get("totalPrice") or 0.0
                        if parsed.get('price') and float(parsed.get('price')) > 0:
                            listings.append(parsed)

                    if listings:
                        if max_price and max_price > 0:
                            listings = [it for it in listings if it.get('price', 0) > 0 and it['price'] <= max_price]
                        print(json.dumps({"success": True, "items": listings}), flush=True)
                        return
                    else:
                        # API returned empty data structure - print snippet for debugging
                        snippet = json.dumps(data)[:500].replace("\n", " ")
                        print(json.dumps({"success": False, "error": "API_NO_ITEMS", "body_snippet": snippet}), flush=True)
                        return

            except Exception as e_api:
                print(json.dumps({"success": False, "error": "API_REQUEST_FAILED", "exception": str(e_api)}), flush=True)
                return

            # Fallback: fetch catalog HTML (preserve original behavior but with diagnostic output on failure)
            try:
                async with session.get(url, headers={"User-Agent": ua, "Accept-Language": "de-DE,de;q=0.9,en;q=0.8"}) as page_res:
                    page_text = await page_res.text()
                    if page_res.status != 200:
                        snippet = page_text[:500].replace("\n", " ")
                        print(json.dumps({"success": False, "error": "CATALOG_FETCH_FAILED", "status": page_res.status, "body_snippet": snippet}), flush=True)
                        return

                    listings = parse_listings(page_text, search_text)
                    if max_price and max_price > 0:
                        listings = [item for item in listings if item.get('price', 0) > 0 and item['price'] <= max_price]
                    print(json.dumps({"success": True, "items": listings}), flush=True)
                    return
            except Exception as e_fallback:
                print(json.dumps({"success": False, "error": "FALLBACK_FAILED", "exception": str(e_fallback)}), flush=True)
                return

    except Exception as e:
        result = {"success": False, "error": str(e), "items": []}
        print(json.dumps(result), flush=True)

if __name__ == "__main__":
    asyncio.run(main())