// every page file exports a `Page` constant implementing this contract; PageMenu and routeConfig
// consume it so navigation + routing derive from one source per page (sandbox convention).
export default interface IPage {
  // url segment, lower-cased into the route path: /{basePath}/{pageName}
  pageName: string;
  // human label shown in the navigation menu
  displayLabel: string;
  // optional permission key; when set the route is wrapped in AuthorizedRoute
  permission?: string;
}
