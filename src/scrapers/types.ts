export interface ScrapedItem {
  id: string;
  title: string;
  price: number;
  size: string;
  brand: string;
  link: string;
  imageUrl: string;
  platform: string;
  condition?: string;
  publishedAt?: string;
  countryTitle?: string;
  reviewCount?: number;
  photos?: string[];
}

export interface SearchOptions {
  maxPrice?: number;
  category?: string;
}

export interface Scraper {
  name: string;
  search: (query: string, options: SearchOptions) => Promise<ScrapedItem[]>;
  lastRawHtml?: string;
}
