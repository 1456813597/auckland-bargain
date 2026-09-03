export type Retailer = string;
export type Category = string;

export type PricePoint = { date: string; price: number };

export type Deal = {
  id: string;
  name: string;
  size: string;
  brand: string;
  category: Category;
  retailer: Retailer;
  store: string;
  price: number;
  regularPrice: number;
  average90d: number;
  low90d: number;
  score: number;
  promotion: string;
  memberOnly: boolean;
  imageUrl?: string;
  color: string;
  history: PricePoint[];
};

const history = (values: number[]): PricePoint[] => {
  const labels = ["03 Jun", "17 Jun", "01 Jul", "15 Jul", "29 Jul", "12 Aug", "30 Aug"];
  return values.map((price, index) => ({ date: labels[index], price }));
};

export const demoDeals: Deal[] = [
  { id: "whittakers-creamy-milk-250g", name: "Whittaker’s Creamy Milk", size: "250g", brand: "Whittaker’s", category: "Snacks", retailer: "PAK’nSAVE", store: "PAK’nSAVE Wairau Road", price: 4.99, regularPrice: 6.79, average90d: 6.52, low90d: 4.99, score: 91, promotion: "90-day low", memberOnly: false, imageUrl: "https://assets.woolworths.com.au/images/2010/266869.jpg?impolicy=wowcdxwbjbx&w=800&h=800", color: "#f4b942", history: history([6.49, 6.79, 5.99, 6.79, 6.49, 5.79, 4.99]) },
  { id: "anchor-butter-500g", name: "Anchor Salted Butter", size: "500g", brand: "Anchor", category: "Dairy", retailer: "PAK’nSAVE", store: "PAK’nSAVE Albany", price: 5.49, regularPrice: 7.99, average90d: 7.42, low90d: 5.49, score: 88, promotion: "Excellent deal", memberOnly: false, imageUrl: "https://assets.woolworths.com.au/images/2010/281759.jpg?impolicy=wowcdxwbjbx&w=800&h=800", color: "#83a977", history: history([7.79, 7.49, 6.99, 7.99, 7.49, 6.49, 5.49]) },
  { id: "bluebird-original-150g", name: "Bluebird Original Cut", size: "150g", brand: "Bluebird", category: "Snacks", retailer: "New World", store: "New World Birkenhead", price: 2.49, regularPrice: 3.99, average90d: 3.79, low90d: 2.49, score: 86, promotion: "Club+ price", memberOnly: true, imageUrl: "https://assets.woolworths.com.au/images/2010/6033995.jpg?impolicy=wowcdxwbjbx&w=800&h=800", color: "#ee8267", history: history([3.79, 3.99, 3.49, 3.99, 3.79, 2.99, 2.49]) },
  { id: "mainland-cheese-500g", name: "Mainland Edam Cheese", size: "500g", brand: "Mainland", category: "Dairy", retailer: "Woolworths", store: "Woolworths Milford", price: 8.9, regularPrice: 11.5, average90d: 10.76, low90d: 8.5, score: 82, promotion: "Weekly special", memberOnly: false, imageUrl: "https://assets.woolworths.com.au/images/2010/281911.jpg?impolicy=wowcdxwbjbx&w=800&h=800", color: "#6fa4c6", history: history([10.5, 11.5, 10.9, 9.5, 11.5, 10.5, 8.9]) },
  { id: "vogels-toast-750g", name: "Vogel’s Original Mixed Grain", size: "750g", brand: "Vogel’s", category: "Pantry", retailer: "New World", store: "New World Albany", price: 4.79, regularPrice: 6.29, average90d: 5.84, low90d: 4.49, score: 78, promotion: "Save $1.50", memberOnly: false, imageUrl: "https://assets.woolworths.com.au/images/2010/275509.jpg?impolicy=wowcdxwbjbx&w=800&h=800", color: "#b08a62", history: history([5.99, 6.29, 5.49, 5.99, 6.29, 5.49, 4.79]) },
  { id: "gold-kiwifruit-1kg", name: "Zespri Gold Kiwifruit", size: "1kg loose", brand: "Zespri", category: "Produce", retailer: "PAK’nSAVE", store: "PAK’nSAVE Sylvia Park", price: 5.99, regularPrice: 7.49, average90d: 7.02, low90d: 5.79, score: 74, promotion: "Seasonal value", memberOnly: false, imageUrl: "https://assets.woolworths.com.au/images/2010/282876.jpg?impolicy=wowcdxwbjbx&w=800&h=800", color: "#9aaa43", history: history([7.99, 7.49, 6.99, 6.49, 6.99, 6.49, 5.99]) },
  { id: "ecostore-laundry-2l", name: "Ecostore Laundry Liquid", size: "2L", brand: "Ecostore", category: "Household", retailer: "Woolworths", store: "Woolworths Greenlane", price: 12, regularPrice: 16, average90d: 14.45, low90d: 11.5, score: 72, promotion: "Everyday Rewards", memberOnly: true, imageUrl: "https://assets.woolworths.com.au/images/2010/63988.jpg?impolicy=wowcdxwbjbx&w=800&h=800", color: "#83a8a1", history: history([15, 16, 13.5, 15.5, 14, 16, 12]) },
  { id: "anchor-blue-milk-2l", name: "Anchor Blue Milk", size: "2L", brand: "Anchor", category: "Dairy", retailer: "New World", store: "New World Victoria Park", price: 5.79, regularPrice: 6.49, average90d: 6.18, low90d: 5.69, score: 63, promotion: "Fair value", memberOnly: false, imageUrl: "https://assets.woolworths.com.au/images/2010/282819.jpg?impolicy=wowcdxwbjbx&w=800&h=800", color: "#6e93bd", history: history([6.19, 6.29, 6.19, 6.49, 6.19, 6.09, 5.79]) },
];

export const categories = ["All", "Dairy", "Snacks", "Pantry", "Produce", "Household"] as const;
export const retailers = ["All retailers", "PAK’nSAVE", "New World", "Woolworths"] as const;

export const money = new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" });

export function discountPercent(deal: Deal) {
  return Math.round(((deal.average90d - deal.price) / deal.average90d) * 100);
}
