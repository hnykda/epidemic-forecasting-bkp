initial.options <- commandArgs(trailingOnly = FALSE)
file.arg.name <- "--file="
script.name <- sub(file.arg.name, "", initial.options[grep(file.arg.name, initial.options)])
script.basename <- dirname(script.name)
other.name <- file.path(script.basename, "dependencies.R")
source(other.name)

# the lag on which to compute the incidence vector
# this can be used as a testing lag constant
INCIDENCE_LAG <- 1

# The sliding window on which to estimate R
ESTIMATION_WINDOW <- 14

# How much percent of population of confirmed cases to start estimating from
PERCENT_TO_OUTBREAK <- 1e-6

country_codes <- function(cases) {
  return(unique(cases$code))
}

load_country <- function(cases, country_code) {
  country_cases <- filter(cases, code == country_code) %>%
    mutate(date = as.Date(date)) %>%
    arrange(date) %>%
    mutate(
      lag_cases = lag(confirmed, INCIDENCE_LAG),
      new_cases = confirmed - lag_cases,
      new_cases = ifelse(is.na(new_cases), 1, new_cases),
      new_cases = ifelse(new_cases < 0, 0, new_cases)
    ) %>%
    rename(
      I = new_cases,
      dates = date
    )

  outbreak_threshold <- country_cases$population[1] * PERCENT_TO_OUTBREAK
  outbreak_start <- which(country_cases$confirmed > outbreak_threshold)[1]
  if(is.na(outbreak_start)){
    return(NULL)
  }

  country_cases <- country_cases[outbreak_start:nrow(country_cases), names(country_cases)] %>%
    select(I, dates)

  return (country_cases)
}

estimate_r <- function(cases, country_code, si_sample) {
  inc <- load_country(cases, country_code)

  if (is.null(inc) || nrow(inc) <= ESTIMATION_WINDOW + 1){
    return(NULL)
  }

  t_start <- seq(2, nrow(inc) - ESTIMATION_WINDOW + 1)
  t_end <- t_start + ESTIMATION_WINDOW - 1
  # R estimation with saved SI data
  R_mcmc_estimated_si <- estimate_R(
    inc,
    method = "si_from_sample",
    si_sample = si_sample,
    config = make_config(
      t_start = t_start,
      t_end = t_end
    )
  )

  out <- data.frame(
    Date=R_mcmc_estimated_si$dates[R_mcmc_estimated_si$R$t_end],
    RMean=R_mcmc_estimated_si$R['Mean(R)'],
    RStd=R_mcmc_estimated_si$R['Std(R)'],
    check.names=FALSE
  ) %>% rename(
    MeanR="Mean(R)",
    StdR="Std(R)"
  )
  out$Code = country_code
  return(out)
}

main <- function(si_sample_file, input_file, output_file) {
  #Code,Date,Recovered,Confirmed,Deaths,Active
  cases <- read.csv(
    input_file,
    colClasses=c("character", "character", "numeric", "numeric", "numeric", "numeric", "numeric"),
    na.strings=""
  )
  names(cases) <- names(cases) %>% tolower() %>% str_replace('[\\/]', '_')

  countries <- country_codes(cases)
  print(paste("Estimating R from JH data", input_file, "on", length(countries), "countries and writing to", output_file))
  si_sample <- read_rds(si_sample_file)

  cores <- detectCores()
  cl <- makeCluster(cores[1]-1) #not to overload your computer
  registerDoParallel(cl)
  export <- data.frame(code=NULL, date=NULL, MeanR=NULL, StdR=NULL)
  export <- foreach(
    i = seq_along(countries),
    .combine=rbind,
    .export = c("estimate_r", "load_country", "INCIDENCE_LAG", "ESTIMATION_WINDOW", "PERCENT_TO_OUTBREAK"),
    .packages = requiredPackages
  ) %dopar% {
    country_code <- countries[i]
    estimate_r(cases, country_code, si_sample)
  }
  stopCluster(cl)


  write.csv(export, output_file)
  print(paste("Exported R estimates for", length(countries), "countries to", output_file))
}

if (!interactive()) {
  args <- commandArgs(trailingOnly = TRUE)
  si_sample_file <- args[1]
  input_file <- args[2]
  output_file <- args[3]
  main(si_sample_file, input_file, output_file)
}
