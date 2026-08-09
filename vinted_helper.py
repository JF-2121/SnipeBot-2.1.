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
import traceback

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

VINTED_BASE_URL = "https://www.vinted.de/catalog"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

def _parse_price_text(text: str):
    """Extract price from text"""
    cleaned = html.unescape(text).strip()
    patterns = [
        r"(?<!\d)(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?)\s*€",
        r"€\s*(\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})?)",
    ]
    for pattern in patterns:
        match = re.search(pattern, cleaned)
        if not match:
            continue
        raw = match.group(1).replace(" ", "")
        raw = raw.replace(".", "")
        if "," in raw:
            raw = raw.replace(",", ".")
        try:
            return float(raw)
        except ValueError:
            continue
    return None

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
    
    # Extract price from title
    price = _parse_price_text(title)
    
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
    
    # Extract brand from search text
    brand = search_text.split()[0] if search_text else "Unknown"
    
    return {
        'id': listing_id,
        'title': title,
        'price': price if price else 0.0,
        'size': 'N/A',
        'brand': brand,
        'link': url if url.startswith('http') else f"https://www.vinted.de{url}",
        'imageUrl': image_url,
        'photos': [image_url] if image_url else [],
        'condition': 'N/A',
        'publishedAt': '',
        'countryTitle': 'Germany',
        'reviewCount': 0,
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
            
            # Try to find items in various locations
            for key, value in r_data.items():
                if isinstance(value, dict):
                    if 'items' in value:
                        items_data = value['items']
                        if isinstance(items_data, dict) and 'catalogItems' in items_data:
                            catalog_items = items_data['catalogItems']
                            break
                        elif isinstance(items_data, list):
                            catalog_items = items_data
                            break
                    if 'catalogItems' in value:
                        catalog_items = value['catalogItems']
                        break
            
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
            
            title = item_data.get('title', f"Item {listing_id}")
            price = item_data.get('price', 0)
            if isinstance(price, str):
                price = _parse_price_text(price) or 0.0
            elif isinstance(price, dict):
                price = float(price.get('amount', 0))
            
            brand = search_text.split()[0] if search_text else ""
            if 'brand_title' in item_data:
                brand = item_data['brand_title']
            elif 'brand' in item_data:
                brand_obj = item_data['brand']
                if isinstance(brand_obj, dict):
                    brand = brand_obj.get('title', brand)
            
            url = item_data.get('url', f"/items/{listing_id}")
            
            photos = []
            if 'photos' in item_data:
                for photo in item_data['photos'][:2]:
                    if isinstance(photo, dict):
                        photo_url = photo.get('url') or photo.get('full_size_url', '')
                        if photo_url:
                            photos.append(photo_url)
            
            image_url = photos[0] if photos else ""
            
            listings.append({
                'id': listing_id,
                'title': title,
                'price': float(price),
                'size': 'N/A',
                'brand': brand,
                'link': url if url.startswith('http') else f"https://www.vinted.de{url}",
                'imageUrl': image_url,
                'photos': photos,
                'condition': 'N/A',
                'publishedAt': '',
                'countryTitle': 'Germany',
                'reviewCount': 0,
                'platform': 'vinted'
            })
        else:
            # Fallback: Extract from HTML
            item = extract_from_anchor_html(html_text, listing_id, match.start(), match.end(), search_text)
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
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5.0)) as session:
            async with session.get(url, headers=headers) as response:
                if response.status != 200:
                    result = {"success": True, "items": []}
                    print(json.dumps(result), flush=True)
                    return
                
                html_text = await response.text()
                listings = parse_listings(html_text, search_text)
                
                if max_price and max_price > 0:
                    listings = [
                        item for item in listings 
                        if item.get('price', 0) > 0 and item['price'] <= max_price
                    ]
                
                result = {"success": True, "items": listings}
                print(json.dumps(result), flush=True)
                
    except Exception as e:
        result = {"success": False, "error": str(e), "items": []}
        print(json.dumps(result), flush=True)

if __name__ == "__main__":
    asyncio.run(main())